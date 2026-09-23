[![CI](https://github.com/jaxer/mqtt-file-transfer/actions/workflows/ci.yml/badge.svg)](https://github.com/jaxer/mqtt-file-transfer/actions/workflows/ci.yml)

# mqtt-file-transfer

Send large files, gigabytes included, over an MQTT broker. The library checks every chunk and the whole file, fills gaps without resending everything, and reports progress. It comes as a TypeScript library plus a CLI.

## How it works

1. **Open a stream.** The sender publishes the file size and a request token to `storage/addFile`. The receiver answers on `storage/addFile/response` with a stream id and a chunk size (64 KB).
2. **Send chunks.** Each chunk goes to `storage/stream/{streamId}/chunk/{offset}/{sha256}` at QoS 0. The offset and the chunk's SHA-256 travel in the topic, so the payload is the raw bytes.
3. **Receive.** The receiver verifies each chunk's checksum, writes it at its offset, records it in a bitmap, and publishes `progress`.
4. **Finish.** The sender publishes `eof` with the SHA-256 of the whole file. If chunks are missing or the file checksum doesn't match, the receiver asks for a `retransfer`, and every retransferred chunk resets the sender's timeout.
5. **Acknowledge.** The receiver publishes `ack` with the stored file's URL. Either side can publish `abort` with a reason.

Chunks travel at QoS 0 and the protocol does its own acknowledgement and retransfer. Control topics (`eof`, `ack`, `abort`, `retransfer`, `progress`) use QoS 1.

## Use

```bash
npm install
# terminal 1
npx ts-node src/cli.ts receive -h localhost -p 1883 --protocol mqtt received-files/
# terminal 2
npx ts-node src/cli.ts send -h localhost -p 1883 --protocol mqtt path/to/file.bin
```

TLS client certificates are supported with `--protocol mqtts -C cert.pem -k key.pem`.

As a library, `MqttFileSender#transferFile(path)` resolves to the URL the receiver acknowledged, and `MqttFileReceiver` writes incoming files into a work directory. Both talk to the broker through `MqttClientFacade`, and `MqttjsFacade` wraps mqtt.js.

## Tests

```bash
(cd docker && docker compose up -d)   # Mosquitto
npm run test:e2e
```

## License

[MIT](./LICENSE)
