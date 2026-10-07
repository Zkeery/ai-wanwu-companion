"""Build the pinned PNG codec inside the isolated VM, never on the host."""
from linux_rehearsal import PROJECT, WORK, INSTANCE, guest_root, lima, save

COMMIT = '12731092979c6d07f42da27da673a9f6c7b13586'


def main():
    root = guest_root()
    script = '''set -eu
cd "$1"
sudo apt-get install -y build-essential cmake
git clone --depth 1 --branch 2.3.3 https://github.com/zlib-ng/zlib-ng.git .runtime/r813-codec-source
test "$(git -C .runtime/r813-codec-source rev-parse HEAD)" = "$2"
cmake -S .runtime/r813-codec-source -B .runtime/r813-codec-build -DZLIB_COMPAT=ON -DZLIB_ENABLE_TESTS=OFF -DWITH_GTEST=OFF -DBUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$1/.runtime/r813-codec"
cmake --build .runtime/r813-codec-build --parallel 4
cmake --install .runtime/r813-codec-build
LD_LIBRARY_PATH="$1/.runtime/r813-codec/lib" backend/.venv/bin/python -m pytest -q backend/tests/test_motion_builder.py::test_v1_saved_apple_render_unchanged
'''
    lima('shell', INSTANCE, 'sh', '-c', script, 'r813', root, COMMIT, timeout=600)
    save(WORK / 'native-codec.json', dict(version='2.3.3', source_commit=COMMIT,
         source='https://github.com/zlib-ng/zlib-ng/releases/tag/2.3.3',
         compat=True, architecture='aarch64', golden_png_contract='passed'))
    print('native_linux_png_codec_and_original_byte_contract_passed')


if __name__ == '__main__':
    main()
