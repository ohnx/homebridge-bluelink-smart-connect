import {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  HAP,
  Logging,
  Service,
} from 'homebridge';

import {Mutex} from 'async-mutex';

import {https} from 'follow-redirects';

let hap: HAP;

/*
 * Initializer function called when the plugin is loaded.
 */
export = (api: API) => {
  hap = api.hap;
  api.registerAccessory('BlueLinkThermostat', BlueLinkThermostat);
};

class BluelinkApiWrapper {
  private readonly log: Logging;
  private readonly host: string = 'sd2.bluelinksmartconnect.com';
  private readonly username: string;
  private readonly password: string;
  private auth_token: string | null;
  private cookie_jar: string[];
  private device_id: string | null;
  private cache;
  private mutex;

  constructor(log, username, password) {
    this.log = log;
    this.username = username;
    this.password = password;

    this.auth_token = null;
    this.cookie_jar = [];
    this.device_id = null;
    this.cache = {device_state: {time: 0, data: {}}};
    this.login((resp, err) => {
      if (!err) {
        this.get_devices(null);
      }
    });
    this.mutex = new Mutex();
  }

  private send_request(endpoint, payload, with_authorization = true, callback) {
    const opts = {
      hostname: this.host,
      path: endpoint,
      method: payload ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Braeburn/13 CFNetwork/1406.0.4 Darwin/22.4.0',
      },
    };

    if (with_authorization) {
      opts.headers['Authorization'] = `Token ${this.auth_token}`;
      opts.headers['Cookie'] = `${this.cookie_jar.join(' ')}`;
    }

    const req = https.request(opts, (res) => {
      this.log.info(`${payload ? 'POST' : 'GET'} ${endpoint}: ${res.statusCode}`);
      let responseData = '';
      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        if (callback) {
          callback({data: responseData, headers: res.headers}, null);
        }
      });
    });

    if (payload) {
      req.write(JSON.stringify(payload));
    }

    req.end();
    req.on('error', (error) => {
      this.log.error(error);
      if (callback) {
        callback(null, error);
      }
    });
  }

  login(callback) {
    const login_details = {password: this.password, username: this.username};
    this.send_request('/api/v1/braeburn/rest-auth/login/', login_details, false, (response, err) => {
      if (err) {
        if (callback) {
          callback(null, err);
        }
        return;
      }

      const {data, headers} = response;
      this.auth_token = JSON.parse(data).key;
      this.cookie_jar = headers['set-cookie'].map(x => {
        x.split(';')[0];
      });

      if (callback) {
        callback(true, null);
      }
    });
  }

  get_devices(callback) {
    this.send_request('/api/v1/braeburn/devices/', null, true, (response, err) => {
      if (err) {
        if (callback) {
          callback(null, err);
        }
        return;
      }

      const responseData = JSON.parse(response.data);
      if (responseData.length < 1) {
        this.log.error('No thermostats in account!');
        return;
      } else if (responseData.length > 1) {
        this.log.error('More than one thermostat in account, will manage first!');
      }

      this.device_id = responseData[0].uuid;
      if (callback) {
        callback(responseData[0], null);
      }
    });
  }

  get_device_state(callback) {
    if (!this.device_id) {
      return this.get_devices(callback);
    }

    // use mutex because for some silly reason apple home makes like 10
    // concurrent requests which kills the whole rate limiting thing
    this.mutex
      .acquire()
      .then(() => {
        const rn = Date.now();
        if (rn - this.cache.device_state.time < 5000) {
        // return cached response
          this.log.info('using cached mode! (< 5s)');
          this.mutex.release();
          if (callback) {
            callback(this.cache.device_state.data, null);
          }
          return;
        }

        this.send_request('/api/v1/braeburn/devices/'+this.device_id, null, true, (response, err) => {
          if (err) {
            this.mutex.release();
            if (callback) {
              callback(null, err);
            }
            return;
          }

          const responseData = JSON.parse(response.data);
          this.cache.device_state.data = responseData;
          this.cache.device_state.time = Date.now();
          this.mutex.release();
          if (callback) {
            callback(responseData, null);
          }
        });
      });
  }

  set_device_state(state, callback) {
    this.send_request('/api/v1/braeburn/manage/'+this.device_id+'/setstateattr/', state, true, (response, err) => {
      if (err) {
        if (callback) {
          callback(null, err);
        }
        return;
      }

      // invalidate the cache
      this.cache.device_state.time = 0;

      if (callback) {
        callback(true, null);
      }
    });
  }

  is_celsius(state) {
    // 07 = 2, 09 = 0 => celsius
    if (state['state_data']['Installer_Setting_07'] === '2') {
      return true;
    }

    // 07 = 3, 09 = 1 => fahrenheit
    return false;
  }
}

class BlueLinkThermostat implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly name: string;
  private config: AccessoryConfig;
  private api: API;
  private bluelink_api: BluelinkApiWrapper;
  private readonly service: Service;
  private readonly informationService: Service;

  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    log.info('Thermostat starting initializing!');

    // extract name from config
    this.name = config.name;

    // get username and password
    if (!config.username || !config.password) {
      log.error('Please specify Bluelink username and password in the config using keys `username` and `password`');
    }
    this.bluelink_api = new BluelinkApiWrapper(log, config.username, config.password);

    // create a new Thermostat service
    this.service = new hap.Service.Thermostat(this.name);

    // create handlers for required characteristics
    this.service.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
      .on('get', this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.service.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .on('get', this.handleTargetHeatingCoolingStateGet.bind(this))
      .on('set', this.handleTargetHeatingCoolingStateSet.bind(this))
    // no support for auto
      .setProps({validValues: [0, 1, 2]});

    this.service.getCharacteristic(hap.Characteristic.CurrentTemperature)
      .on('get', this.handleCurrentTemperatureGet.bind(this));

    this.service.getCharacteristic(hap.Characteristic.TargetTemperature)
      .on('get', this.handleTargetTemperatureGet.bind(this))
      .on('set', this.handleTargetTemperatureSet.bind(this))
      .setProps({minStep: 1});

    this.service.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
      .on('get', this.handleTemperatureDisplayUnitsGet.bind(this))
      .on('set', this.handleTemperatureDisplayUnitsSet.bind(this));

    // info
    this.informationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Braeburn')
      .setCharacteristic(hap.Characteristic.Model, 'BlueLink SmartConnect Thermostat');

    log.info('Thermostat finished initializing!');
  }

  /**
   * Handle requests to get the current value of the 'Current Heating Cooling State' characteristic
   */
  handleCurrentHeatingCoolingStateGet(callback) {
    this.bluelink_api.get_device_state((state, err) => {
      if (err) {
        return;
      }
      this.log.info('CurrentHeatingCoolingState', state['state_data']['User_Setting_02']);
      switch(state['state_data']['User_Setting_02']) {
        case '0': callback(null, hap.Characteristic.CurrentHeatingCoolingState.OFF); break;
        case '1': callback(null, hap.Characteristic.CurrentHeatingCoolingState.HEAT); break;
        case '2': callback(null, hap.Characteristic.CurrentHeatingCoolingState.COOL); break;
        default: this.log.error(`bad response from API ${state['state_data']['User_Setting_02']}`);
      }
    });
  }

  /**
   * Handle requests to get the current value of the 'Target Heating Cooling State' characteristic
   */
  handleTargetHeatingCoolingStateGet(callback) {
    this.bluelink_api.get_device_state((state, err) => {
      if (err) {
        return;
      }
      this.log.info('TargetHeatingCoolingState', state['state_data']['User_Setting_02']);
      switch(state['state_data']['User_Setting_02']) {
        case '0': callback(null, hap.Characteristic.TargetHeatingCoolingState.OFF); break;
        case '1': callback(null, hap.Characteristic.TargetHeatingCoolingState.HEAT); break;
        case '2': callback(null, hap.Characteristic.TargetHeatingCoolingState.COOL); break;
        default: this.log.error(`bad response from API ${state['state_data']['User_Setting_02']}`);
      }
    });
  }

  /**
   * Handle requests to set the 'Target Heating Cooling State' characteristic
   */
  handleTargetHeatingCoolingStateSet(value) {
    this.bluelink_api.set_device_state({'User_Setting_02': `${value}`}, null);
  }

  /**
   * Handle requests to get the current value of the 'Current Temperature' characteristic
   */
  handleCurrentTemperatureGet(callback) {
    this.bluelink_api.get_device_state((state, err) => {
      if (err) {
        return;
      }
      let temp = parseFloat(state['state_data']['Status_01']) / 100;

      if (this.bluelink_api.is_celsius(state)) {
        // F => C
        temp = (temp - 32) / 1.8;
      }

      callback(null, temp);
    });
  }

  /**
   * Handle requests to get the current value of the 'Target Temperature' characteristic
   */
  handleTargetTemperatureGet(callback) {
    this.bluelink_api.get_device_state((state, err) => {
      if (err) {
        return;
      }
      let temp = parseFloat(state['state_data']['Status_01']) / 100;
      switch(state['state_data']['User_Setting_02']) {
        case '0':
        // copy of get temp code above
          if (this.bluelink_api.is_celsius(state)) {
          // F => C
            temp = (temp - 32) / 1.8;
          }
          callback(null, temp);
          break;
        case '1': callback(null, state['state_data']['User_Setting_04']); break;
        case '2': callback(null, state['state_data']['User_Setting_05']); break;
        default: this.log.error(`bad response from API ${state['state_data']['User_Setting_02']}`);
      }
    });
  }

  /**
   * Handle requests to set the 'Target Temperature' characteristic
   */
  handleTargetTemperatureSet(value) {
    this.log.info('Triggered SET TargetTemperature:', value);

    this.bluelink_api.get_device_state((state, err) => {
      if (err) {
        return;
      }
      switch(state['state_data']['User_Setting_02']) {
        case '0': // system is off... idk??
          break;
        case '1': // heat
          this.bluelink_api.set_device_state({'User_Setting_04':`${value}`}, null);
          break;
        case '2': // cool
          this.bluelink_api.set_device_state({'User_Setting_05':`${value}`}, null);
          break;
        default: this.log.error(`bad response from API ${state['state_data']['User_Setting_02']}`);
      }
    });
  }

  /**
   * Handle requests to get the current value of the 'Temperature Display Units' characteristic
   */
  handleTemperatureDisplayUnitsGet(callback) {
    //this.log.info('Triggered GET TemperatureDisplayUnits');

    this.bluelink_api.get_device_state((state, err) => {
      if (err) {
        return;
      }
      if (this.bluelink_api.is_celsius(state)) {
        // 07 = 2, 09 = 0 => celsius
        callback(null, hap.Characteristic.TemperatureDisplayUnits.CELSIUS);
      } else {
        // 07 = 3, 09 = 1 => fahrenheit
        callback(null, hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
      }
    });
  }

  /**
   * Handle requests to set the 'Temperature Display Units' characteristic
   */
  handleTemperatureDisplayUnitsSet(value) {
    this.log.info('Triggered SET TemperatureDisplayUnits:', value);
  }

  /*
   * This method is optional to implement. It is called when HomeKit ask to identify the accessory.
   * Typical this only ever happens at the pairing process.
   */
  identify(): void {
    this.log('Identify!');
  }

  /*
   * This method is called directly after creation of this instance.
   * It should return all services which should be added to the accessory.
   */
  getServices(): Service[] {
    return [
      this.informationService,
      this.service,
    ];
  }

}
