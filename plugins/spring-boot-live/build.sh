#!/bin/sh
# Builds luma-spring-boot-live.jar (Java 17 bytecode; needs a JDK 17+ with jdk.attach).
set -e
cd "$(dirname "$0")"
rm -rf build && mkdir -p build/classes
javac --release 17 -d build/classes $(find src -name '*.java')
printf 'Main-Class: ai.luma.boot.live.Main\n' > build/MANIFEST.MF
jar --create --file luma-spring-boot-live.jar --manifest build/MANIFEST.MF -C build/classes .
rm -rf build
echo "built $(pwd)/luma-spring-boot-live.jar"
