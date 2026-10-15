"""Signs release APKs with the project keystore (CI only).

`tauri android init` regenerates gen/android on every run, so the release signing
config is added to its app/build.gradle.kts here. Usage (from mobile/):
    python ci/configure_signing.py <keystore.jks> <password>
Google sign-in matches the app by this key's SHA-1, so it must never change.
"""
import pathlib
import sys

keystore, password = sys.argv[1], sys.argv[2]
android = pathlib.Path("src-tauri/gen/android")
(android / "keystore.properties").write_text(
    f"keyAlias=token-view\npassword={password}\nstoreFile={pathlib.Path(keystore).resolve().as_posix()}\n"
)

gradle = android / "app" / "build.gradle.kts"
s = gradle.read_text()
if "signingConfigs" not in s:
    # Inside `android { }`, `java` names the Java extension, so import the types.
    for imp in ("import java.io.FileInputStream", "import java.util.Properties"):
        if imp not in s:
            s = imp + "\n" + s
    s = s.replace(
        "android {",
        """android {
    signingConfigs {
        create("release") {
            val props = Properties().apply { load(FileInputStream(rootProject.file("keystore.properties"))) }
            keyAlias = props["keyAlias"] as String
            keyPassword = props["password"] as String
            storeFile = file(props["storeFile"] as String)
            storePassword = props["password"] as String
        }
    }""",
        1,
    )
    marker = 'getByName("release") {'
    assert marker in s, "release build type not found in generated build.gradle.kts"
    s = s.replace(marker, marker + '\n            signingConfig = signingConfigs.getByName("release")', 1)
    gradle.write_text(s)
print("release signing configured")
