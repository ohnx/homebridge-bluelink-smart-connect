# Homebridge bluelink smart connect

Homebridge plugin for the bluelink smart connect smart thermostat.
It was installed in my yuppie box in new york city. maybe someone else will
find it useful?

## usage notes

My thermostat is this one, ymmv with a different one.

<img width="975" alt="image" src="https://github.com/ohnx/homebridge-bluelink-smart-connect/assets/6683648/e9ce7f21-b69b-41ba-9a87-edb3f69685eb">

To set it up with wifi, you will have to take the thermostat off of the wall - there are plastic clips so it will snap off, sort of.
There's a code in the back that tells you how to set up wifi.

* Setup guide (how to use wifi): https://braeburnonline.com/sites/braeburn/files/products/manuals/7300%20Setup.pdf
* User guide: https://braeburnonline.com/sites/braeburn/files/products/manuals/Braeburn%207300%207305%20User%20Manual_0.pdf
* Installer guide (how to switch to celsius): https://braeburnonline.com/sites/braeburn/files/products/manuals/Braeburn%207300%207305%20Installer%20Guide_0.pdf

**You must switch your thermostat to celsius to have this work.**
Actually this is a lie and you can totally have the homebridge plugin work with a few tweaks,
but i'm lazy and i use my thermostat in C mode. It's unfortunate that I lose ~1/2 degree of precision
(the thermostat only supports integer setpoints, for both C and F), but at least i know
what the numbers mean.

My homebridge config looks like this:

```json
    "accessories": [
        {
            "accessory": "BlueLinkThermostat",
            "name": "BlueLinkThermostat",
            "username": "my_email@example.com",
            "password": "password123"
        }
    ],
```

## development notes

Everything was reverse engineered based on the bluelink smart connect ios app:
https://apps.apple.com/us/app/bluelink-smart-connect/id978578562

basically the api is this: (all calls go to `sd2.bluelinksmartconnect.com`)

1. `POST /api/v1/braeburn/rest-auth/login/` with username and password. rx some cookies (session id) plus an auth token.
    all subsequent requests have this auth token and cookies.
2. `GET /api/v1/braeburn/devices/`. not strictly necessary - this is just getting the id of the thermostat.
3. `GET /api/v1/braeburn/devices/<thermostat_id>/` gets the state of the thermostat.
   i'm not sure what every key means, but here are explanations for a few under `state_data`
   (the part that's interesting - the other stuff is pretty boring)

    * `Status_01`: temperature, always in fahrenheit * 100 (e.g. 23 C => 7340, 30 C => 8600)
    * `User_Setting_02`: current heating/cooling setting. 0 = off, 1 = heat, 2 = cool.
    * `User_Setting_04`: heating target temp, in system temperature.
    * `User_Setting_05`: cooling target temp, in system temperature.
    * If i had to guess, 09/10 have something to do with fan mode.
    * `Installer_Setting_07` and `Installer_Setting_09`: when the pair is `(2, 0)`, the system is using celsius.
       when the pair is `(3, 1)`, the system is using fahrenheit.
    * `Installer_Setting_11`: allowed set range, i think? first 2 digits look like they're the max heating, last 2 digits look like they're min coolling.
      this setting changes depending on C/F.
4. `POST /api/v1/braeburn/manage/<thermostat_id>/setstateattr` sets specific parameters. example body:
   ```
   {"User_Setting_05":"24","User_Setting_04":"16"}
   ```

i know this isn't much. there's plenty of cool stuff with geofencing, etc., but i
just reversed the bare minimum for the functionality that i wanted, where most of
the actual "smart" temperature control will be done by homekit automations.

oh also, there's some rate limiting on the api side. not sure about the exact rate,
but i have some caching in place in order to help avoid running into errors.
