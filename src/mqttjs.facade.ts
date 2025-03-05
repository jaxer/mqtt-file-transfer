import { MqttClientFacade } from './mqtt-client.facade';
import { MqttClient } from 'mqtt';

export class MqttjsFacade extends MqttClientFacade {
    constructor(private readonly _client: MqttClient) {
        super();
    }

    public async subscribe(
        topicFilter: string,
        qos: 0 | 1 | 2,
        messageProcessor: (topic: string, message: ArrayBuffer) => void,
    ): Promise<void> {
        this._client.subscribe(topicFilter, { qos });

        this._client.on('message', (receivedTopic, message) => {
            if (this._isMatch(topicFilter, receivedTopic)) {
                messageProcessor(receivedTopic, message);
            }
        });
    }

    public async unsubscribe(topic: string): Promise<void> {
        await this._client.unsubscribeAsync(topic);
    }

    public async publish(
        topic: string,
        message: ArrayBuffer | string,
        qos: 0 | 1 | 2,
        retain: boolean,
    ): Promise<void> {
        await this._client.publishAsync(
            topic,
            typeof message === 'string' ? message : Buffer.from(message),
            {
                qos,
                retain,
            },
        );
    }

    private _isMatch(filter: string, topic: string) {
        const filterSegments = filter.split('/');
        const topicSegments = topic.split('/');

        for (let i = 0; i < filterSegments.length; i++) {
            const segment = filterSegments[i];
            if (segment === '#') {
                return true;
            }
            if (topicSegments[i] === undefined) {
                return false;
            }
            if (segment === '+') {
                continue;
            }
            if (segment !== topicSegments[i]) {
                return false;
            }
        }

        return filterSegments.length === topicSegments.length;
    }
}
