'use strict';

const utils = require('@iobroker/adapter-core');
const {SerialPort} = require('serialport');

class RollershutterArduino extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: 'rollershutter-arduino',
        });

        this.serialPort = null;
        this.reconnectTimer = null;
        this.isConnecting = false;
        this.schedulerInterval = null;

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

        // Create automation objects
        await this.createAutomationObjects();

        // Initialize serial connection
        await this.initializeSerialConnection();

        // Start automation scheduler
        this.startScheduler();

        this.log.info('Adapter started successfully');
    }

    async createRollershutterObjects() {
        this.log.info('Creating rollershutter objects...');

        for (const shutter of this.config.rollershutters) {
            const objectName = this.sanitizeName(shutter.name);

            // Create single state object for this rollershutter
            await this.setObjectNotExistsAsync(objectName, {
                type: 'state',
                common: {
                    name: shutter.name,
                    type: 'string',
                    role: 'switch',
                    read: true,
                    write: true,
                    states: {
                        'open': 'Open',
                        'close': 'Close',
                        'stop': 'Stop'
                    }
                },
                native: {
                    id: shutter.id,
                    openCommand: shutter.openCommand,
                    closeCommand: shutter.closeCommand,
                    stopCommand: shutter.stopCommand
                }
            });

            // Subscribe to state changes for this rollershutter
            this.subscribeStates(objectName);
        }
    }

    async createAutomationObjects() {
        this.log.info('Creating automation objects...');

        // Create global automation settings
        await this.createGlobalAutomationObjects();

        // Create individual override objects for each shutter
        for (const shutter of this.config.rollershutters) {
            await this.createIndividualAutomationObjects(shutter);
        }
    }

    async createGlobalAutomationObjects() {
        // Global automation enabled/disabled
        await this.setObjectNotExistsAsync('global_automation_enabled', {
            type: 'state',
            common: {
                name: 'Global Automation Enabled',
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
                def: false
            },
            native: {}
        });

        // Global workday schedule
        await this.setObjectNotExistsAsync('global_workday_open_time', {
            type: 'state',
            common: {
                name: 'Global Workday Open Time',
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '07:00'
            },
            native: {}
        });

        await this.setObjectNotExistsAsync('global_workday_close_time', {
            type: 'state',
            common: {
                name: 'Global Workday Close Time',
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '22:00'
            },
            native: {}
        });

        // Global weekend schedule
        await this.setObjectNotExistsAsync('global_weekend_open_time', {
            type: 'state',
            common: {
                name: 'Global Weekend Open Time',
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '09:30'
            },
            native: {}
        });

        await this.setObjectNotExistsAsync('global_weekend_close_time', {
            type: 'state',
            common: {
                name: 'Global Weekend Close Time',
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '22:00'
            },
            native: {}
        });

        // Subscribe to global automation state changes
        this.subscribeStates('global_automation_enabled');
        this.subscribeStates('global_workday_open_time');
        this.subscribeStates('global_workday_close_time');
        this.subscribeStates('global_weekend_open_time');
        this.subscribeStates('global_weekend_close_time');
    }

    async createIndividualAutomationObjects(shutter) {
        const objectName = this.sanitizeName(shutter.name);

        // Individual automation override enabled/disabled
        await this.setObjectNotExistsAsync(`${objectName}_automation_override`, {
            type: 'state',
            common: {
                name: `${shutter.name} - Override Global Settings`,
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
                def: false
            },
            native: {}
        });

        // Individual automation enabled/disabled (only used if override is enabled)
        await this.setObjectNotExistsAsync(`${objectName}_automation_enabled`, {
            type: 'state',
            common: {
                name: `${shutter.name} - Individual Automation Enabled`,
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
                def: true
            },
            native: {}
        });

        // Individual workday schedule
        await this.setObjectNotExistsAsync(`${objectName}_workday_open_time`, {
            type: 'state',
            common: {
                name: `${shutter.name} - Individual Workday Open Time`,
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '07:00'
            },
            native: {}
        });

        await this.setObjectNotExistsAsync(`${objectName}_workday_close_time`, {
            type: 'state',
            common: {
                name: `${shutter.name} - Individual Workday Close Time`,
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '21:00'
            },
            native: {}
        });

        // Individual weekend schedule
        await this.setObjectNotExistsAsync(`${objectName}_weekend_open_time`, {
            type: 'state',
            common: {
                name: `${shutter.name} - Individual Weekend Open Time`,
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '09:30'
            },
            native: {}
        });

        await this.setObjectNotExistsAsync(`${objectName}_weekend_close_time`, {
            type: 'state',
            common: {
                name: `${shutter.name} - Individual Weekend Close Time`,
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '21:00'
            },
            native: {}
        });

        // Subscribe to individual automation state changes
        this.subscribeStates(`${objectName}_automation_override`);
        this.subscribeStates(`${objectName}_automation_enabled`);
        this.subscribeStates(`${objectName}_workday_open_time`);
        this.subscribeStates(`${objectName}_workday_close_time`);
        this.subscribeStates(`${objectName}_weekend_open_time`);
        this.subscribeStates(`${objectName}_weekend_close_time`);
    }

    startScheduler() {
        if (this.schedulerInterval) {
            return; // Already running
        }

        this.log.info('Starting automation scheduler');
        this.schedulerInterval = setInterval(async () => {
            try {
                await this.checkAutomationSchedule();
            } catch (error) {
                this.log.error(`Error in automation scheduler: ${error.message}`);
            }
        }, 60000); // Check every minute

        // Also check immediately with proper error handling
        this.checkAutomationSchedule().catch(error => {
            this.log.error(`Error in initial automation check: ${error.message}`);
        });
    }

    stopScheduler() {
        if (this.schedulerInterval) {
            clearInterval(this.schedulerInterval);
            this.schedulerInterval = null;
            this.log.info('Automation scheduler stopped');
        }
    }

    async getEffectiveAutomationSettings(shutterObjectName) {
        try {
            // Check if this shutter uses individual override
            const overrideState = await this.getStateAsync(`${shutterObjectName}_automation_override`);
            const useOverride = overrideState && overrideState.val;

            if (useOverride) {
                // Use individual settings
                const enabled = await this.getStateAsync(`${shutterObjectName}_automation_enabled`);
                const workdayOpen = await this.getStateAsync(`${shutterObjectName}_workday_open_time`);
                const workdayClose = await this.getStateAsync(`${shutterObjectName}_workday_close_time`);
                const weekendOpen = await this.getStateAsync(`${shutterObjectName}_weekend_open_time`);
                const weekendClose = await this.getStateAsync(`${shutterObjectName}_weekend_close_time`);

                return {
                    enabled: enabled ? enabled.val : false,
                    workdayOpenTime: workdayOpen ? workdayOpen.val : '07:00',
                    workdayCloseTime: workdayClose ? workdayClose.val : '22:00',
                    weekendOpenTime: weekendOpen ? weekendOpen.val : '08:00',
                    weekendCloseTime: weekendClose ? weekendClose.val : '23:00',
                    source: 'individual'
                };
            } else {
                // Use global settings
                const enabled = await this.getStateAsync('global_automation_enabled');
                const workdayOpen = await this.getStateAsync('global_workday_open_time');
                const workdayClose = await this.getStateAsync('global_workday_close_time');
                const weekendOpen = await this.getStateAsync('global_weekend_open_time');
                const weekendClose = await this.getStateAsync('global_weekend_close_time');

                return {
                    enabled: enabled ? enabled.val : false,
                    workdayOpenTime: workdayOpen ? workdayOpen.val : '07:00',
                    workdayCloseTime: workdayClose ? workdayClose.val : '22:00',
                    weekendOpenTime: weekendOpen ? weekendOpen.val : '08:00',
                    weekendCloseTime: weekendClose ? weekendClose.val : '23:00',
                    source: 'global'
                };
            }
        } catch (error) {
            this.log.error(`Error getting automation settings for ${shutterObjectName}: ${error.message}`);
            // Return safe defaults
            return {
                enabled: false,
                workdayOpenTime: '07:00',
                workdayCloseTime: '22:00',
                weekendOpenTime: '08:00',
                weekendCloseTime: '23:00',
                source: 'default'
            };
        }
    }

    async checkAutomationSchedule() {
        try {
            const now = new Date();
            const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
            const isWorkday = this.isWorkday(now);

            for (const shutter of this.config.rollershutters) {
                try {
                    const objectName = this.sanitizeName(shutter.name);

                    // Get effective automation settings for this shutter
                    const settings = await this.getEffectiveAutomationSettings(objectName);

                    if (!settings.enabled) {
                        continue;
                    }

                    // Get the appropriate times based on day type
                    const openTime = isWorkday ? settings.workdayOpenTime : settings.weekendOpenTime;
                    const closeTime = isWorkday ? settings.workdayCloseTime : settings.weekendCloseTime;

                    // Validate time format
                    if (!this.isValidTimeFormat(openTime) || !this.isValidTimeFormat(closeTime)) {
                        this.log.warn(`Invalid time format for ${shutter.name}. Expected HH:MM format.`);
                        continue;
                    }

                    // Check if current time matches open time
                    if (currentTime === openTime) {
                        this.log.info(`Automated opening of ${shutter.name} at ${currentTime} (${isWorkday ? 'workday' : 'weekend'}, ${settings.source} settings)`);
                        await this.executeAutomatedCommand(shutter, 'open');
                    }

                    // Check if current time matches close time
                    if (currentTime === closeTime) {
                        this.log.info(`Automated closing of ${shutter.name} at ${currentTime} (${isWorkday ? 'workday' : 'weekend'}, ${settings.source} settings)`);
                        await this.executeAutomatedCommand(shutter, 'close');
                    }
                } catch (shutterError) {
                    this.log.error(`Error processing automation for shutter ${shutter.name}: ${shutterError.message}`);
                    // Continue with next shutter even if one fails
                }
            }
        } catch (error) {
            this.log.error(`Critical error in checkAutomationSchedule: ${error.message}`);
            throw error; // Re-throw so the caller can handle it
        }
    }

    isWorkday(date) {
        const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
        return dayOfWeek >= 1 && dayOfWeek <= 5; // Monday to Friday
    }

    isValidTimeFormat(timeString) {
        const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
        return timeRegex.test(timeString);
    }

    async executeAutomatedCommand(shutter, action) {
        let commandToSend = '';
        switch (action) {
            case 'open':
                commandToSend = shutter.openCommand;
                break;
            case 'close':
                commandToSend = shutter.closeCommand;
                break;
            default:
                this.log.warn(`Unknown automated action: ${action} for rollershutter: ${shutter.name}`);
                return;
        }

        this.log.info(`Executing automated ${action} command for ${shutter.name}: ${commandToSend}`);
        const success = await this.sendCommand(commandToSend);

        if (success) {
            // Update the state to reflect the automated action
            const objectName = this.sanitizeName(shutter.name);
            await this.setState(objectName, action, true);
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
            const parts = id.split('.');
            const objectName = parts.pop(); // Get the object name (last part after namespace)

            // Handle automation configuration changes
            if (objectName.startsWith('global_') ||
                objectName.includes('_automation_') ||
                objectName.includes('_workday_') ||
                objectName.includes('_weekend_')) {
                this.log.info(`Automation setting changed: ${objectName} = ${state.val}`);
                await this.setState(id, state.val, true);
                return;
            }

            // Handle manual rollershutter commands
            const command = state.val; // "open", "close", or "stop"

            // Find the corresponding rollershutter configuration
            const shutter = this.config.rollershutters.find(s =>
                this.sanitizeName(s.name) === objectName
            );

            if (!shutter) {
                this.log.warn(`No configuration found for rollershutter: ${objectName}`);
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
                    this.log.warn(`Unknown command: ${command} for rollershutter: ${shutter.name}`);
                    return;
            }

            this.log.info(`Sending manual ${command} command for ${shutter.name}: ${commandToSend}`);
            const success = await this.sendCommand(commandToSend);

            // Acknowledge the state
            await this.setState(id, command, true);
        }
    }

    onUnload(callback) {
        try {
            // Stop automation scheduler
            this.stopScheduler();

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