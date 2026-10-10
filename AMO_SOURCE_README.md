# AMO source submission: ChatGPT Markdown Export 0.6.37

This archive contains the human-readable source and the build instructions for the Firefox add-on uploaded to addons.mozilla.org as `chatgpt-export-firefox-amo-0.6.37.zip`.

## Build environment

- Supported build systems: Ubuntu 24.04 LTS, Windows 10/11, or macOS 13 or later.
- Required runtime: Python 3.10 or later. The build was checked with Python 3.11.9 on Windows; it uses only Python's standard library.
- No Node.js, npm, compiler, network access, or package installation is required.
- `lib/marked.umd.js` is the unchanged third-party Marked 12.0.2 library. Its license notice is included in the file header.

## Reproduce the Firefox AMO package

1. Extract this source archive into a new, empty directory.
2. Install Python 3.10 or later if it is not already available. On Ubuntu, Python 3 is available from the official repositories; on Windows or macOS, use the installer from [python.org](https://www.python.org/downloads/).
3. Open a terminal in the extracted source directory.
4. Run the build/setup script:

   - Ubuntu or macOS: `python3 setup_build.py`
   - Windows: `py -3 setup_build.py` (or `python setup_build.py`)

5. The script checks the Python version and starts `build.py`. The Firefox AMO package is written to `dist/chatgpt-export-firefox-amo-0.6.37.zip`.

The build script copies the readable JavaScript, HTML, CSS, icons, and bundled library without transpiling, concatenating, minifying, or generating application source. It adapts the root manifest for Firefox and packages the result. The build process recreates the `dist/` directory, so run it from the clean extracted source directory, not from a development checkout containing files you want to keep.

## Source layout

- `manifest.json`: shared extension manifest before browser-specific adaptation.
- `src/`: extension logic and export rendering.
- `popup/`: toolbar popup interface.
- `icons/`: extension icons.
- `lib/marked.umd.js`: bundled third-party Markdown parser.
- `build.py`: reproducible packaging for Firefox and Chromium-based browsers.
- `setup_build.py`: environment check and build entry point.
