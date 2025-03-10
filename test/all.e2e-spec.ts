import * as mqtt from 'mqtt';
import { MqttFileReceiver, MqttFileSender, MqttjsFacade } from '../src';

jest.setTimeout(30000); // 30 seconds

describe('with real MQTT Broker', () => {
    let receiverClient: mqtt.MqttClient;
    let senderClient: mqtt.MqttClient;

    beforeEach(async () => {
        receiverClient = await mqtt.connectAsync('mqtt://localhost:1883');
        senderClient = await mqtt.connectAsync('mqtt://localhost:1883');
    });

    describe('with MqttFileReceiver subscribed', () => {
        let receiver: MqttFileReceiver;

        beforeEach(async () => {
            receiver = new MqttFileReceiver(
                './received-files',
                new MqttjsFacade(receiverClient),
            );

            await receiver.addSubscriptions();
        });

        describe('MqttFileSender', () => {
            let sender: MqttFileSender;

            beforeEach(async () => {
                sender = new MqttFileSender(senderClient);
            });

            it('transferFile sends file over and return fileUrl', async () => {
                const fileUrl = await sender.transferFile(
                    'test/random_1KB.bin',
                );

                expect(fileUrl).toMatch(/^file:\/\/.*$/);
            });
        });
    });

    afterEach(async () => {
        if (receiverClient) {
            await receiverClient.endAsync();
        }

        if (senderClient) {
            await senderClient.endAsync();
        }
    });
});
