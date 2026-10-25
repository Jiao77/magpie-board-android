import os, sys, subprocess, shutil

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(ROOT_DIR, "app")
SRC_DIR = os.path.join(APP_DIR, "src", "main")
BUILD_DIR = os.path.join(APP_DIR, "build")
GEN_DIR = os.path.join(BUILD_DIR, "gen")
OBJ_DIR = os.path.join(BUILD_DIR, "obj")
APK_DIR = os.path.join(BUILD_DIR, "apk")
DIST_DIR = os.path.join(ROOT_DIR, "release")

# Locate Android SDK
sdk_candidates = [
    os.environ.get("ANDROID_HOME"),
    os.environ.get("ANDROID_SDK_ROOT"),
    os.path.join(ROOT_DIR, "..", "magpie-multi-sub2api", "work", "android-sdk"),
    os.path.expanduser("~/Library/Android/sdk"),
    "/opt/homebrew/share/android-commandlinetools"
]
SDK_DIR = None
for cand in sdk_candidates:
    if cand and os.path.exists(cand):
        SDK_DIR = os.path.abspath(cand)
        break

if not SDK_DIR:
    print("Error: Could not locate Android SDK. Please set ANDROID_HOME environment variable.")
    sys.exit(1)

print(f"Using Android SDK at: {SDK_DIR}")

# Clean obj and apk dirs
if os.path.exists(OBJ_DIR):
    shutil.rmtree(OBJ_DIR)
if os.path.exists(APK_DIR):
    shutil.rmtree(APK_DIR)

for d in [GEN_DIR, OBJ_DIR, APK_DIR, DIST_DIR]:
    os.makedirs(d, exist_ok=True)

# Find build tools
build_tools_dir = os.path.join(SDK_DIR, "build-tools")
bt_versions = sorted(os.listdir(build_tools_dir)) if os.path.exists(build_tools_dir) else []
if not bt_versions:
    print("Error: No build-tools found in SDK.")
    sys.exit(1)
bt_dir = os.path.join(build_tools_dir, bt_versions[-1])

aapt2 = os.path.join(bt_dir, "aapt2")
d8 = os.path.join(bt_dir, "d8")
zipalign = os.path.join(bt_dir, "zipalign")
apksigner = os.path.join(bt_dir, "apksigner")

# Find android.jar
platforms_dir = os.path.join(SDK_DIR, "platforms")
plat_versions = sorted([p for p in os.listdir(platforms_dir) if p.startswith("android-")]) if os.path.exists(platforms_dir) else []
if not plat_versions:
    print("Error: No platform android.jar found in SDK.")
    sys.exit(1)
android_jar = os.path.join(platforms_dir, plat_versions[-1], "android.jar")

res_zip = os.path.join(BUILD_DIR, "res.zip")
unaligned_apk = os.path.join(APK_DIR, "unaligned.apk")
aligned_apk = os.path.join(APK_DIR, "aligned.apk")
output_apk = os.path.join(DIST_DIR, "MagpieBoard-v1.0.0.apk")

print("Step 1: Compiling resources with aapt2...")
subprocess.check_call([
    aapt2, "compile",
    "--dir", os.path.join(SRC_DIR, "res"),
    "-o", res_zip
])

print("Step 2: Linking resources and assets with aapt2...")
subprocess.check_call([
    aapt2, "link",
    "-I", android_jar,
    "--manifest", os.path.join(SRC_DIR, "AndroidManifest.xml"),
    "-A", os.path.join(SRC_DIR, "assets"),
    "-o", unaligned_apk,
    "--java", GEN_DIR,
    res_zip
])

print("Step 3: Compiling Java source files with javac...")
java_files = [
    os.path.join(GEN_DIR, "com", "magpie", "monitor", "R.java"),
    os.path.join(SRC_DIR, "java", "com", "magpie", "monitor", "WebAppInterface.java"),
    os.path.join(SRC_DIR, "java", "com", "magpie", "monitor", "MainActivity.java")
]
subprocess.check_call([
    "javac", "-encoding", "UTF-8", "-source", "8", "-target", "8",
    "-bootclasspath", android_jar,
    "-d", OBJ_DIR
] + java_files)

print("Step 4: Compiling class files to classes.dex with d8...")
classes = []
for root, _, files in os.walk(OBJ_DIR):
    for f in files:
        if f.endswith(".class") and not f.startswith("._"):
            classes.append(os.path.join(root, f))

subprocess.check_call([d8, "--lib", android_jar, "--output", APK_DIR] + classes)

print("Step 5: Injecting classes.dex into APK package...")
subprocess.check_call(["zip", "-j", unaligned_apk, os.path.join(APK_DIR, "classes.dex")])

print("Step 6: Aligning APK with zipalign...")
if os.path.exists(aligned_apk):
    os.remove(aligned_apk)
subprocess.check_call([zipalign, "-f", "-p", "4", unaligned_apk, aligned_apk])

print("Step 7: Signing APK with apksigner...")
keystore_path = os.path.join(BUILD_DIR, "magpie-release.keystore")
if not os.path.exists(keystore_path):
    subprocess.check_call([
        "keytool", "-genkeypair", "-v", "-keystore", keystore_path,
        "-alias", "magpiekey", "-storepass", "magpie123", "-keypass", "magpie123",
        "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
        "-dname", "CN=Magpie,OU=Monitor,O=Magpie,C=CN"
    ])

if os.path.exists(output_apk):
    os.remove(output_apk)

subprocess.check_call([
    apksigner, "sign",
    "--ks", keystore_path,
    "--ks-pass", "pass:magpie123",
    "--key-pass", "pass:magpie123",
    "--out", output_apk,
    aligned_apk
])

print("Step 8: Verifying APK signature...")
subprocess.check_call([apksigner, "verify", "-v", output_apk])

size_bytes = os.path.getsize(output_apk)
size_mb = size_bytes / (1024 * 1024)
print("\n" + "="*50)
print(f"BUILD COMPLETED SUCCESSFULLY!")
print(f"Artifact: {output_apk}")
print(f"Size: {size_bytes} bytes ({size_mb:.2f} MB)")
print("="*50)
