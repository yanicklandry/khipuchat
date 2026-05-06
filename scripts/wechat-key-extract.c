/*
 * wechat-key-extract.c
 * Extracts the SQLCipher key from a running WeChat for Mac process by
 * scanning heap memory and verifying candidates against the database HMAC.
 *
 * Prerequisites:
 *   - WeChat must be ad-hoc signed (no hardened runtime):
 *       sudo codesign --force --deep --sign - /Applications/WeChat.app
 *   - WeChat must be running with databases open (log in to WeChat first)
 *
 * Build:
 *   cc -O2 -o wechat-key-extract wechat-key-extract.c \
 *      -framework Security -framework CoreFoundation \
 *      -lCommonCrypto 2>/dev/null || \
 *   cc -O2 -o wechat-key-extract wechat-key-extract.c \
 *      -framework Security -framework CoreFoundation
 *
 * Usage:
 *   ./wechat-key-extract <pid> <path_to_message_0.db>
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <CommonCrypto/CommonCrypto.h>
#include <CommonCrypto/CommonKeyDerivation.h>

#define PAGE_SZ   4096
#define RESERVE   80
#define SALT_SZ   16
#define KEY_SZ    32
#define HMAC_SZ   64   /* SHA-512 */
#define ITER_MAC  2

/*
 * SQLCipher 4 HMAC verification:
 * mac_salt = salt XOR 0x3a (each byte)
 * mac_key  = PBKDF2-HMAC-SHA512(enc_key, mac_salt, 2, 32)
 * hmac_data = page1[16 .. page_sz-64-1]  (content + IV)
 * stored   = page1[page_sz-64 .. page_sz-1]
 * expected = HMAC-SHA512(mac_key, hmac_data || page_num_le32)
 */
static int verify_key(const uint8_t *key, const uint8_t *page1)
{
    const uint8_t *salt = page1;

    /* derive MAC key */
    uint8_t mac_salt[SALT_SZ];
    for (int i = 0; i < SALT_SZ; i++) mac_salt[i] = salt[i] ^ 0x3a;

    uint8_t mac_key[KEY_SZ];
    CCKeyDerivationPBKDF(kCCPBKDF2,
                         (const char *)key, KEY_SZ,
                         mac_salt, SALT_SZ,
                         kCCPRFHmacAlgSHA512,
                         ITER_MAC,
                         mac_key, KEY_SZ);

    /* HMAC-SHA512 over [16..PAGE_SZ-HMAC_SZ) + page_number(=1, 4 bytes LE) */
    size_t data_len = PAGE_SZ - HMAC_SZ - SALT_SZ; /* 4096-64-16 = 4016 */
    const uint8_t *hmac_data = page1 + SALT_SZ;
    uint32_t page_no = 1;

    CCHmacContext ctx;
    CCHmacInit(&ctx, kCCHmacAlgSHA512, mac_key, KEY_SZ);
    CCHmacUpdate(&ctx, hmac_data, data_len);
    CCHmacUpdate(&ctx, &page_no, sizeof(page_no));
    uint8_t computed[HMAC_SZ];
    CCHmacFinal(&ctx, computed);

    const uint8_t *stored = page1 + PAGE_SZ - HMAC_SZ;
    return memcmp(computed, stored, HMAC_SZ) == 0;
}

int main(int argc, char *argv[])
{
    if (argc < 3) {
        fprintf(stderr,
            "Usage: %s <wechat_pid> <path_to_message_0.db>\n\n"
            "WeChat must be ad-hoc signed first:\n"
            "  sudo codesign --force --deep --sign - /Applications/WeChat.app\n"
            "Then restart WeChat and log in before running this tool.\n",
            argv[0]);
        return 1;
    }

    pid_t pid = (pid_t)atoi(argv[1]);
    const char *db_path = argv[2];

    /* Read first page of database */
    FILE *f = fopen(db_path, "rb");
    if (!f) {
        fprintf(stderr, "Cannot open database: %s\n", db_path);
        return 1;
    }
    uint8_t page1[PAGE_SZ];
    if (fread(page1, 1, PAGE_SZ, f) != PAGE_SZ) {
        fprintf(stderr, "Database too small\n");
        fclose(f);
        return 1;
    }
    fclose(f);

    /* Sanity: first 16 bytes must not be "SQLite format 3" */
    if (memcmp(page1, "SQLite format 3", 15) == 0) {
        fprintf(stderr, "Database is not encrypted.\n");
        return 1;
    }

    /* Get task port for the WeChat process */
    mach_port_t task = MACH_PORT_NULL;
    kern_return_t kr = task_for_pid(mach_task_self(), pid, &task);
    if (kr != KERN_SUCCESS) {
        fprintf(stderr,
            "task_for_pid failed (kr=%d).\n"
            "Make sure WeChat has been ad-hoc signed:\n"
            "  sudo codesign --force --deep --sign - /Applications/WeChat.app\n"
            "Then restart WeChat and log in.\n",
            kr);
        return 1;
    }

    fprintf(stderr, "Scanning WeChat (pid=%d) memory for SQLCipher key...\n", pid);

    mach_vm_address_t addr = 0;
    uint64_t regions_scanned = 0;
    uint64_t bytes_scanned = 0;
    int found = 0;

    while (!found) {
        mach_vm_size_t region_size = 0;
        vm_region_basic_info_data_64_t info;
        mach_msg_type_number_t info_count = VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t object_name = MACH_PORT_NULL;

        kr = mach_vm_region(task, &addr, &region_size,
                            VM_REGION_BASIC_INFO_64,
                            (vm_region_info_t)&info,
                            &info_count, &object_name);
        if (kr != KERN_SUCCESS) break;

        if (object_name != MACH_PORT_NULL)
            mach_port_deallocate(mach_task_self(), object_name);

        /* Only scan read+write regions (heap, stack) */
        int readable = (info.protection & VM_PROT_READ) != 0;
        int writable = (info.protection & VM_PROT_WRITE) != 0;

        if (readable && writable && region_size >= KEY_SZ) {
            uint8_t *buf = malloc(region_size);
            if (buf) {
                mach_vm_size_t bytes_read = 0;
                kr = mach_vm_read_overwrite(task, addr, region_size,
                                            (mach_vm_address_t)buf,
                                            &bytes_read);
                if (kr == KERN_SUCCESS && bytes_read >= KEY_SZ) {
                    for (mach_vm_size_t i = 0;
                         i + KEY_SZ <= bytes_read && !found;
                         i++) {
                        if (verify_key(buf + i, page1)) {
                            /* Print key as 64-char hex */
                            printf("WECHAT_DB_KEY=");
                            for (int j = 0; j < KEY_SZ; j++)
                                printf("%02x", buf[i + j]);
                            printf("\n");
                            found = 1;
                        }
                    }
                    bytes_scanned += bytes_read;
                }
                free(buf);
            }
            regions_scanned++;
        }

        addr += region_size;
    }

    mach_port_deallocate(mach_task_self(), task);

    if (!found) {
        fprintf(stderr,
            "Key not found in %.1f MB scanned across %llu regions.\n"
            "Make sure WeChat is running and you are logged in.\n",
            (double)bytes_scanned / (1024 * 1024),
            regions_scanned);
        return 1;
    }

    fprintf(stderr, "Key found! Scanned %.1f MB.\n",
            (double)bytes_scanned / (1024 * 1024));
    return 0;
}
