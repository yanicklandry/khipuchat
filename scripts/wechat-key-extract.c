/*
 * wechat-key-extract.c
 * Scan a running WeChat 4.x process for its SQLCipher key.
 *
 * WeChat stores the key in process memory as the ASCII literal:
 *   x'<64-hex-enc-key><32-hex-salt>'
 * We search for that text pattern, then verify each candidate against the
 * salt embedded in message_0.db's first page.
 *
 * Prerequisites:
 *   WeChat must be ad-hoc re-signed (removes Hardened Runtime):
 *     sudo codesign --force --deep --sign - /Applications/WeChat.app
 *   Then restart WeChat and log in before running this tool.
 *
 * Build:
 *   cc -O2 -arch arm64 -arch x86_64 \
 *      -o wechat-key-extract wechat-key-extract.c \
 *      -framework CoreFoundation
 *
 * Usage:
 *   sudo ./wechat-key-extract <pid> <path_to_message_0.db>
 *
 * Output (stdout):
 *   WECHAT_DB_KEY=<64-hex-chars>
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>

#define CHUNK_SIZE   (2 * 1024 * 1024)  /* read 2 MB at a time */
#define KEY_HEX_LEN  64
#define SALT_HEX_LEN 32
#define PATTERN_LEN  (KEY_HEX_LEN + SALT_HEX_LEN)  /* 96 hex chars */
#define MAX_KEYS     256
#define SALT_BYTES   16
#define PAGE_SZ      4096

typedef struct {
    char key_hex[KEY_HEX_LEN + 1];
    char salt_hex[SALT_HEX_LEN + 1];
} key_entry_t;

static int is_hex(unsigned char c)
{
    return (c >= '0' && c <= '9') ||
           (c >= 'a' && c <= 'f') ||
           (c >= 'A' && c <= 'F');
}

static void to_lower(char *s, int len)
{
    for (int i = 0; i < len; i++)
        if (s[i] >= 'A' && s[i] <= 'F') s[i] += 32;
}

/* Read the first 16 bytes of the DB file and return them as a lowercase hex string. */
static int read_db_salt(const char *path, char salt_hex_out[SALT_HEX_LEN + 1])
{
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    unsigned char buf[SALT_BYTES];
    if ((int)fread(buf, 1, SALT_BYTES, f) != SALT_BYTES) { fclose(f); return -1; }
    fclose(f);
    /* Reject unencrypted SQLite files */
    if (memcmp(buf, "SQLite format 3", 15) == 0) return -1;
    for (int i = 0; i < SALT_BYTES; i++)
        sprintf(salt_hex_out + i * 2, "%02x", buf[i]);
    salt_hex_out[SALT_HEX_LEN] = '\0';
    return 0;
}

int main(int argc, char *argv[])
{
    if (argc < 3) {
        fprintf(stderr,
            "Usage: %s <wechat_pid> <path_to_message_0.db>\n\n"
            "WeChat must be ad-hoc signed first:\n"
            "  sudo codesign --force --deep --sign - /Applications/WeChat.app\n"
            "Then restart WeChat and log in.\n",
            argv[0]);
        return 1;
    }

    pid_t pid = (pid_t)atoi(argv[1]);
    const char *db_path = argv[2];

    /* Read the salt from the database file */
    char db_salt[SALT_HEX_LEN + 1];
    if (read_db_salt(db_path, db_salt) != 0) {
        fprintf(stderr, "Cannot read salt from: %s\n"
            "(File may be missing, too small, or already unencrypted)\n", db_path);
        return 1;
    }
    fprintf(stderr, "DB salt: %s\n", db_salt);

    /* Attach to WeChat process */
    mach_port_t task = MACH_PORT_NULL;
    kern_return_t kr = task_for_pid(mach_task_self(), pid, &task);
    if (kr != KERN_SUCCESS) {
        fprintf(stderr,
            "task_for_pid failed (kr=%d).\n"
            "Make sure WeChat has been ad-hoc signed:\n"
            "  sudo codesign --force --deep --sign - /Applications/WeChat.app\n"
            "Then restart WeChat and log in.\n", kr);
        return 1;
    }

    fprintf(stderr, "Scanning WeChat (pid=%d) memory for key pattern...\n", pid);

    key_entry_t keys[MAX_KEYS];
    int key_count = 0;
    size_t total_scanned = 0;

    mach_vm_address_t addr = 0;
    while (1) {
        mach_vm_size_t region_size = 0;
        vm_region_basic_info_data_64_t info;
        mach_msg_type_number_t info_count = VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t obj_name = MACH_PORT_NULL;

        kr = mach_vm_region(task, &addr, &region_size, VM_REGION_BASIC_INFO_64,
                            (vm_region_info_t)&info, &info_count, &obj_name);
        if (kr != KERN_SUCCESS) break;
        if (region_size == 0) { addr++; continue; }

        if (obj_name != MACH_PORT_NULL)
            mach_port_deallocate(mach_task_self(), obj_name);

        /* Only scan read+write regions */
        if ((info.protection & (VM_PROT_READ | VM_PROT_WRITE)) ==
                (VM_PROT_READ | VM_PROT_WRITE)) {

            mach_vm_address_t chunk_addr = addr;
            while (chunk_addr < addr + region_size) {
                mach_vm_size_t chunk_size = addr + region_size - chunk_addr;
                if (chunk_size > CHUNK_SIZE) chunk_size = CHUNK_SIZE;

                vm_offset_t data = 0;
                mach_msg_type_number_t data_count = 0;
                kr = mach_vm_read(task, chunk_addr, chunk_size, &data, &data_count);
                if (kr == KERN_SUCCESS) {
                    unsigned char *buf = (unsigned char *)data;
                    total_scanned += data_count;

                    /* Search for x'<96 hex chars>' */
                    for (mach_msg_type_number_t i = 0;
                         i + PATTERN_LEN + 3 < data_count && key_count < MAX_KEYS;
                         i++) {
                        if (buf[i] != 'x' || buf[i + 1] != '\'') continue;

                        /* Check 96 hex chars */
                        int valid = 1;
                        for (int j = 0; j < PATTERN_LEN; j++) {
                            if (!is_hex(buf[i + 2 + j])) { valid = 0; break; }
                        }
                        if (!valid) continue;
                        if (buf[i + 2 + PATTERN_LEN] != '\'') continue;

                        char key_hex[KEY_HEX_LEN + 1];
                        char salt_hex[SALT_HEX_LEN + 1];
                        memcpy(key_hex,  buf + i + 2,                  KEY_HEX_LEN);
                        memcpy(salt_hex, buf + i + 2 + KEY_HEX_LEN,    SALT_HEX_LEN);
                        key_hex[KEY_HEX_LEN]   = '\0';
                        salt_hex[SALT_HEX_LEN] = '\0';
                        to_lower(key_hex,  KEY_HEX_LEN);
                        to_lower(salt_hex, SALT_HEX_LEN);

                        /* Deduplicate */
                        int dup = 0;
                        for (int k = 0; k < key_count; k++) {
                            if (strcmp(keys[k].key_hex,  key_hex)  == 0 &&
                                strcmp(keys[k].salt_hex, salt_hex) == 0) {
                                dup = 1; break;
                            }
                        }
                        if (!dup) {
                            memcpy(keys[key_count].key_hex,  key_hex,  KEY_HEX_LEN + 1);
                            memcpy(keys[key_count].salt_hex, salt_hex, SALT_HEX_LEN + 1);
                            key_count++;
                        }
                    }
                    mach_vm_deallocate(mach_task_self(), data, data_count);
                }

                /* Advance with overlap to catch patterns spanning chunk boundaries */
                if (chunk_size > (mach_vm_size_t)(PATTERN_LEN + 3))
                    chunk_addr += chunk_size - (PATTERN_LEN + 3);
                else
                    chunk_addr += chunk_size;
            }
        }
        addr += region_size;
    }

    mach_port_deallocate(mach_task_self(), task);

    fprintf(stderr, "Scan complete: %.1f MB scanned, %d unique key(s) found.\n",
            (double)total_scanned / (1024 * 1024), key_count);

    if (key_count == 0) {
        fprintf(stderr,
            "No keys found. Make sure:\n"
            "  1. WeChat is ad-hoc signed (hardened runtime removed)\n"
            "  2. WeChat is running and you are logged in\n"
            "  3. You have opened at least one chat\n");
        return 1;
    }

    /* Output all key+salt pairs as a JSON object: {"<salt>": "<key>", ...} */
    printf("{");
    for (int i = 0; i < key_count; i++) {
        printf("%s\"%s\": \"%s\"",
            i > 0 ? ", " : "",
            keys[i].salt_hex,
            keys[i].key_hex);
    }
    printf("}\n");

    /* Confirm at least the reference DB's salt was found */
    int matched = 0;
    for (int i = 0; i < key_count; i++) {
        if (strcmp(keys[i].salt_hex, db_salt) == 0) { matched = 1; break; }
    }
    if (!matched) {
        fprintf(stderr,
            "Warning: none of the %d found key(s) matched message_0.db's salt.\n"
            "Open a few chats in WeChat and re-run setup.\n", key_count);
    }
    return 0;
}
