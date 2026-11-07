"""Fails if a native library in an APK/AAB is not aligned for 16 KB pages (CI only).

Google Play rejects apps targeting Android 15+ whose .so LOAD segments are aligned
to less than 16 KB. Usage: python ci/check_page_size.py <file.apk|file.aab>
"""
import struct
import sys
import zipfile

PAGE = 16 * 1024
bad = []
libs = 0
with zipfile.ZipFile(sys.argv[1]) as z:
    for info in z.infolist():
        if not info.filename.endswith(".so"):
            continue
        libs += 1
        data = z.read(info.filename)
        if data[:4] != b"\x7fELF" or data[4] != 2:
            bad.append(f"{info.filename}: not a 64-bit ELF")
            continue
        phoff = struct.unpack_from("<Q", data, 0x20)[0]
        phentsize, phnum = struct.unpack_from("<HH", data, 0x36)
        for i in range(phnum):
            off = phoff + i * phentsize
            if struct.unpack_from("<I", data, off)[0] != 1:  # PT_LOAD
                continue
            align = struct.unpack_from("<Q", data, off + 0x30)[0]
            if align < PAGE:
                bad.append(f"{info.filename}: LOAD segment aligned to {align} bytes")
                break
if not libs:
    sys.exit(f"no native libraries found in {sys.argv[1]}")
if bad:
    sys.exit("not 16 KB page aligned:\n  " + "\n  ".join(bad))
print(f"{libs} native librar{'y' if libs == 1 else 'ies'} aligned for 16 KB pages")
