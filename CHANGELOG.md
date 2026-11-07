# Changelog

## 0.1.0 (7 November 2026)

First release, built and tested on Herdr 0.1.13.

- Overview, Workflows (live graphs with runs laid over them, replay, inspector), Failures (grouped by cause, with hints) and Ask Claude.
- Ask Claude: per-instance consent with a word-for-word preview, run search with "Send run data" asked each time, Look further, Open workflow and Open run, replies, and chat history.
- Focus sprites: Probe, Goose and Brackets (designed by [Adam Entwistle](https://github.com/adamentwistle)), Flo, or Off, with a Motion setting.
- Keys kept in the macOS Keychain or the Linux keyring, read-only REST access, and redaction before anything goes to Claude. See [SECURITY.md](SECURITY.md).
- Optional header button with a failure badge, keyboard shortcuts in `keys.json`, and a demo instance.
