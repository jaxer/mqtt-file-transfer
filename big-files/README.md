# Generate with

```bash
dd if=/dev/urandom of=random_100MB.bin bs=1M count=100
dd if=/dev/urandom of=random_2GB.bin bs=1M count=2000
shasum -a 256 random_100MB.bin > random_100MB.bin.sha256.txt
shasum -a 256 random_2GB.bin > random_2GB.bin.sha256.txt
```