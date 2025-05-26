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

        // Create super global objects (only for instance 0 to avoid conflicts)
        if (this.instance === 0) {
            await this.createSuperGlobalObjects();
        }

        // Subscribe to super global changes
        await this.subscribeSuperGlobalStates();

        // Initialize serial connection
        await this.initializeSerialConnection();

        // Start automation scheduler
        this.startScheduler();

        this.log.info('Adapter started successfully');
    }

    async createSuperGlobalObjects() {
        this.log.info('Creating super global automation objects...');

        // Super global automation enabled/disabled
        await this.setObjectNotExistsAsync('system.adapter.rollershutter-arduino.super_global_automation_enabled', {
            type: 'state',
            common: {
                name: 'Super Global Automation Enabled',
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
                def: false
            },
            native: {}
        });

        // Super global workday schedule
        await this.setObjectNotExistsAsync('system.adapter.rollershutter-arduino.super_global_workday_open_time', {
            type: 'state',
            common: {
                name: 'Super Global Workday Open Time',
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '07:00'
            },
            native: {}
        });

        await this.setObjectNotExistsAsync('system.adapter.rollershutter-arduino.super_global_workday_close_time', {
            type: 'state',
            common: {
                name: 'Super Global Workday Close Time',
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '22:00'
            },
            native: {}
        });

        // Super global weekend schedule
        await this.setObjectNotExistsAsync('system.adapter.rollershutter-arduino.super_global_weekend_open_time', {
            type: 'state',
            common: {
                name: 'Super Global Weekend Open Time',
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '09:30'
            },
            native: {}
        });

        await this.setObjectNotExistsAsync('system.adapter.rollershutter-arduino.super_global_weekend_close_time', {
            type: 'state',
            common: {
                name: 'Super Global Weekend Close Time',
                type: 'string',
                role: 'value.time',
                read: true,
                write: true,
                def: '22:00'
            },
            native: {}
        });
    }

    async subscribeSuperGlobalStates() {
        // Subscribe to super global states using foreign state subscription
        this.subscribeForeignStates('system.adapter.rollershutter-arduino.super_global_*');
    }

    async propagateSuperGlobalToGlobal() {
        try {
            this.log.info('Propagating super global settings to global settings...');

            // Get all super global values
            const superGlobalStates = await this.getForeignStatesAsync('system.adapter.rollershutter-arduino.super_global_*');

            const mappings = {
                'system.adapter.rollershutter-arduino.super_global_automation_enabled': 'global_automation_enabled',
                'system.adapter.rollershutter-arduino.super_global_workday_open_time': 'global_workday_open_time',
                'system.adapter.rollershutter-arduino.super_global_workday_close_time': 'global_workday_close_time',
                'system.adapter.rollershutter-arduino.super_global_weekend_open_time': 'global_weekend_open_time',
                'system.adapter.rollershutter-arduino.super_global_weekend_close_time': 'global_weekend_close_time'
            };

            // Propagate each super global setting to the corresponding global setting
            for (const [superGlobalId, globalId] of Object.entries(mappings)) {
                const superGlobalState = superGlobalStates[superGlobalId];
                if (superGlobalState && superGlobalState.val !== null && superGlobalState.val !== undefined) {
                    await this.setState(globalId, superGlobalState.val, true);
                    this.log.debug(`Propagated ${superGlobalId} (${superGlobalState.val}) to ${globalId}`);
                }
            }

            this.log.info('Super global settings propagated successfully');
        } catch (error) {
            this.log.error(`Error propagating super global settings: ${error.message}`);
        }
    }

    async propagateSuperGlobalToAllInstances() {
        try {
            this.log.info('Propagating super global settings to all adapter instances...');

            // Get all rollershutter-arduino adapter instances
            const instances = await this.getForeignObjectsAsync('system.adapter.rollershutter-arduino.*', 'instance');

            // Get super global values
            const superGlobalStates = await this.getForeignStatesAsync('system.adapter.rollershutter-arduino.super_global_*');

            const mappings = {
                'system.adapter.rollershutter-arduino.super_global_automation_enabled': 'global_automation_enabled',
                'system.adapter.rollershutter-arduino.super_global_workday_open_time': 'global_workday_open_time',
                'system.adapter.rollershutter-arduino.super_global_workday_close_time': 'global_workday_close_time',
                'system.adapter.rollershutter-arduino.super_global_weekend_open_time': 'global_weekend_open_time',
                'system.adapter.rollershutter-arduino.super_global_weekend_close_time': 'global_weekend_close_time'
            };

            // Propagate to each instance
            for (const instanceId of Object.keys(instances)) {
                const instanceNumber = instanceId.split('.').pop();

                for (const [superGlobalId, globalStateName] of Object.entries(mappings)) {
                    const superGlobalState = superGlobalStates[superGlobalId];
                    if (superGlobalState && superGlobalState.val !== null && superGlobalState.val !== undefined) {
                        const targetStateId = `rollershutter-arduino.${instanceNumber}.${globalStateName}`;
                        await this.setForeignStateAsync(targetStateId, superGlobalState.val, true);
                        this.log.debug(`Propagated ${superGlobalId} (${superGlobalState.val}) to ${targetStateId}`);
                    }
                }
            }

            this.log.info('Super global settings propagated to all instances successfully');
        } catch (error) {
            this.log.error(`Error propagating super global settings to all instances: ${error.message}`);
        }
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

        // Create individual automation objects for each shutter
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

        // Individual automation enabled/disabled
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
                def: ''
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
                def: ''
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
                def: ''
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
                def: ''
            },
            native: {}
        });

        // Subscribe to individual automation state changes
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
            // First check if global automation is enabled
            const globalEnabledState = await this.getStateAsync('global_automation_enabled');
            const globalEnabled = globalEnabledState ? globalEnabledState.val : false;

            if (!globalEnabled) {
                return {
                    enabled: false,
                    workdayOpenTime: '',
                    workdayCloseTime: '',
                    weekendOpenTime: '',
                    weekendCloseTime: '',
                    source: 'global_disabled'
                };
            }

            // Check if individual automation is enabled for this shutter
            const individualEnabledState = await this.getStateAsync(`${shutterObjectName}_automation_enabled`);
            const individualEnabled = individualEnabledState ? individualEnabledState.val : true;

            if (!individualEnabled) {
                return {
                    enabled: false,
                    workdayOpenTime: '',
                    workdayCloseTime: '',
                    weekendOpenTime: '',
                    weekendCloseTime: '',
                    source: 'individual_disabled'
                };
            }

            // Get global times as fallback
            const globalWorkdayOpen = await this.getStateAsync('global_workday_open_time');
            const globalWorkdayClose = await this.getStateAsync('global_workday_close_time');
            const globalWeekendOpen = await this.getStateAsync('global_weekend_open_time');
            const globalWeekendClose = await this.getStateAsync('global_weekend_close_time');

            const globalTimes = {
                workdayOpen: globalWorkdayOpen ? globalWorkdayOpen.val : '07:00',
                workdayClose: globalWorkdayClose ? globalWorkdayClose.val : '22:00',
                weekendOpen: globalWeekendOpen ? globalWeekendOpen.val : '09:30',
                weekendClose: globalWeekendClose ? globalWeekendClose.val : '22:00'
            };

            // Get individual times
            const individualWorkdayOpen = await this.getStateAsync(`${shutterObjectName}_workday_open_time`);
            const individualWorkdayClose = await this.getStateAsync(`${shutterObjectName}_workday_close_time`);
            const individualWeekendOpen = await this.getStateAsync(`${shutterObjectName}_weekend_open_time`);
            const individualWeekendClose = await this.getStateAsync(`${shutterObjectName}_weekend_close_time`);

            // Use individual times if set and valid, otherwise fall back to global
            const workdayOpenTime = this.getEffectiveTime(
                individualWorkdayOpen ? individualWorkdayOpen.val : '',
                globalTimes.workdayOpen
            );
            const workdayCloseTime = this.getEffectiveTime(
                individualWorkdayClose ? individualWorkdayClose.val : '',
                globalTimes.workdayClose
            );
            const weekendOpenTime = this.getEffectiveTime(
                individualWeekendOpen ? individualWeekendOpen.val : '',
                globalTimes.weekendOpen
            );
            const weekendCloseTime = this.getEffectiveTime(
                individualWeekendClose ? individualWeekendClose.val : '',
                globalTimes.weekendClose
            );

            // Determine source for logging
            const hasIndividualTimes =
                (individualWorkdayOpen && individualWorkdayOpen.val && this.isValidTimeFormat(individualWorkdayOpen.val)) ||
                (individualWorkdayClose && individualWorkdayClose.val && this.isValidTimeFormat(individualWorkdayClose.val)) ||
                (individualWeekendOpen && individualWeekendOpen.val && this.isValidTimeFormat(individualWeekendOpen.val)) ||
                (individualWeekendClose && individualWeekendClose.val && this.isValidTimeFormat(individualWeekendClose.val));

                return {
                enabled: true,
                workdayOpenTime,
                workdayCloseTime,
                weekendOpenTime,
                weekendCloseTime,
                source: hasIndividualTimes ? 'mixed' : 'global'
                };
        } catch (error) {
            this.log.error(`Error getting automation settings for ${shutterObjectName}: ${error.message}`);
            // Return safe defaults
            return {
                enabled: false,
                workdayOpenTime: '07:00',
                workdayCloseTime: '22:00',
                weekendOpenTime: '09:30',
                weekendCloseTime: '22:00',
                source: 'default'
            };
        }
    }

    getEffectiveTime(individualTime, globalTime) {
        // Use individual time if it's set and valid, otherwise use global time
        if (individualTime && this.isValidTimeFormat(individualTime)) {
            return individualTime;
        }
        return globalTime;
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
        if (!timeString || timeString.trim() === '') {
            return false;
        }
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
            // Handle super global state changes
            if (id.startsWith('system.adapter.rollershutter-arduino.super_global_')) {
                this.log.info(`Super global setting changed: ${id} = ${state.val}`);
                await this.setForeignStateAsync(id, state.val, true);

                // Propagate to all instances
                await this.propagateSuperGlobalToAllInstances();
                return;
            }

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

    async onForeignStateChange(id, state) {
        // Handle foreign state changes (super global states)
        if (state && !state.ack && id.startsWith('system.adapter.rollershutter-arduino.super_global_')) {
            this.log.info(`Super global setting changed externally: ${id} = ${state.val}`);

            // Propagate to all instances
            await this.propagateSuperGlobalToAllInstances();
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