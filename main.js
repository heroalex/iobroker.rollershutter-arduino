'use strict';

const utils = require('@iobroker/adapter-core');
const { SerialPort } = require('serialport');

class RollershutterArduino extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: 'rollershutter-arduino',
        });

        this.serialPort = null;
        this.reconnectTimer = null;
        this.isConnecting = false;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        // Reset the connection indicator during startup
        await this.setState('info.connection', false, true);

        // Validate configuration
        if (!this.config.serialPath) {
            this.log.error('Serial path not configured');
            return;
        }

        if (!this.config.rollershutters || this.config.rollershutters.length === 0) {
            this.log.warn('No rollershutters configured');
            return;
        }

        // Create objects for all configured rollershutters
        await this.createRollershutterObjects();

        // Initialize serial connection
        await this.initializeSerialConnection();

        this.log.info('Adapter started successfully');
    }

    async createRollershutterObjects() {
        this.log.info('Creating rollershutter objects...');

        for (const shutter of this.config.rollershutters) {
            const baseName = this.sanitizeName(shutter.name);

            // Create channel for this rollershutter
            await this.setObjectNotExistsAsync(baseName, {
                type: 'channel',
                common: {
                    name: shutter.name,
                    role: 'blind'
                },
                native: {
                    id: shutter.id,
                    openCommand: shutter.openCommand,
                    closeCommand: shutter.closeCommand,
                    stopCommand: shutter.stopCommand
                }
            });

            // Create command states
            await this.setObjectNotExistsAsync(`${baseName}.open`, {
                type: 'state',
                common: {
                    name: `${shutter.name} Open`,
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                    def: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`${baseName}.close`, {
            type: 'state',
            common: {
                    name: `${shutter.name} Close`,
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                    def: false
                },
                native: {}
            });

            await this.setObjectNotExistsAsync(`${baseName}.stop`, {
                type: 'state',
                common: {
                    name: `${shutter.name} Stop`,
                type: 'boolean',
                    role: 'button',
                    read: false,
                write: true,
                    def: false
            },
                native: {}
            });

            // Subscribe to state changes for this rollershutter
            this.subscribeStates(`${baseName}.*`);
        }
    }

    sanitizeName(name) {
        return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    }

    async initializeSerialConnection() {
        if (this.isConnecting) {
            return;
        }

        this.isConnecting = true;
        this.log.info(`Initializing serial connection to ${this.config.serialPath}`);

        try {
            this.serialPort = new SerialPort({
                path: this.config.serialPath,
                baudRate: this.config.baudRate || 9600,
                autoOpen: false
            });

            this.serialPort.on('open', () => {
                this.log.info(`Serial port opened: ${this.config.serialPath}`);
                this.setState('info.connection', true, true);
                this.isConnecting = false;

                // Clear any existing reconnect timer
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
            });

            this.serialPort.on('error', (err) => {
                this.log.error(`Serial port error: ${err.message}`);
                this.setState('info.connection', false, true);
                this.isConnecting = false;
                this.scheduleReconnect();
            });

            this.serialPort.on('close', () => {
                this.log.info('Serial port closed');
                this.setState('info.connection', false, true);
                this.isConnecting = false;
                this.scheduleReconnect();
            });

            this.serialPort.on('data', (data) => {
                this.handleIncomingData(data.toString().trim());
            });

            // Open the port
            this.serialPort.open((err) => {
                if (err) {
                    this.log.error(`Error opening serial port: ${err.message}`);
                    this.isConnecting = false;
                    this.scheduleReconnect();
                }
            });

        } catch (error) {
            this.log.error(`Error creating serial port: ${error.message}`);
            this.isConnecting = false;
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer) {
            return; // Already scheduled
        }

        const interval = this.config.reconnectInterval || 5000;
        this.log.info(`Scheduling reconnect in ${interval}ms`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.initializeSerialConnection();
        }, interval);
    }

    handleIncomingData(data) {
        this.log.debug(`Received data: ${data}`);
        // TODO: Parse feedback from Arduino when physical buttons are pressed
        // This would be implemented based on the actual feedback format from Arduino
    }

    async sendCommand(command) {
        if (!this.serialPort || !this.serialPort.isOpen) {
            this.log.warn(`Cannot send command "${command}" - serial port not open`);
            return false;
        }

        const message = command.endsWith('\n') ? command : command + '\n';

        return new Promise((resolve) => {
            setTimeout(() => {
                this.serialPort.write(message, (err) => {
                    if (err) {
                        this.log.error(`Error sending command "${command}": ${err.message}`);
                        resolve(false);
                    } else {
                        this.log.info(`Command sent: ${command}`);
                        resolve(true);
                    }
        });
            }, this.config.openDelay || 100);
        });
    }

    async onStateChange(id, state) {
        if (state && !state.ack) {
            const idParts = id.split('.');
            const command = idParts[idParts.length - 1]; // 'open', 'close', or 'stop'
            const shutterName = idParts.slice(2, -1).join('.'); // Everything between namespace and command

            // Find the corresponding rollershutter configuration
            const shutter = this.config.rollershutters.find(s =>
                this.sanitizeName(s.name) === shutterName
            );

            if (!shutter) {
                this.log.warn(`No configuration found for rollershutter: ${shutterName}`);
                return;
            }

            let commandToSend = '';
            switch (command) {
                case 'open':
                    commandToSend = shutter.openCommand;
                    break;
                case 'close':
                    commandToSend = shutter.closeCommand;
                    break;
                case 'stop':
                    commandToSend = shutter.stopCommand;
                    break;
                default:
                    this.log.warn(`Unknown command: ${command}`);
                    return;
            }

            this.log.info(`Sending ${command} command for ${shutter.name}: ${commandToSend}`);
            const success = await this.sendCommand(commandToSend);

            // Acknowledge the state
            await this.setState(id, false, true);
        }
    }

    onUnload(callback) {
        try {
            // Clear reconnect timer
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }

            // Close serial port
            if (this.serialPort && this.serialPort.isOpen) {
                this.serialPort.close((err) => {
                    if (err) {
                        this.log.error(`Error closing serial port: ${err.message}`);
                    } else {
                        this.log.info('Serial port closed successfully');
                    }
                    callback();
                });
            } else {
            callback();
            }
        } catch (e) {
            this.log.error(`Error during unload: ${e.message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new RollershutterArduino(options);
} else {
    new RollershutterArduino();
}