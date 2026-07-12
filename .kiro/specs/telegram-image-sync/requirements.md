# Requirements Document

## Project Description (Input)
Telegram photo messages are detected but never downloaded or stored, making image content invisible to search, semantic search, and MCP tools. The existing media columns (`media_file_path`, `media_url`, `media_width`, `media_height`) and GramJS `client.downloadMedia()` are already in place. The goal is to download Telegram images to local storage, OCR them with `tesseract.js`, feed the extracted text into FTS and the semantic embedding pipeline, and expose a new `get_image` MCP tool. The storage helper, OCR module, and MCP tool are designed platform-agnostically so Signal, WeChat, and other platforms can reuse them.

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
