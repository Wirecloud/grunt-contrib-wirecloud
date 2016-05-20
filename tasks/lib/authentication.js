/*
 * Copyright (c) 2015 CoNWeT Lab., Universidad Politécnica de Madrid
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use strict";

var Promise = require('es6-promise').Promise;
var inquirer = require('inquirer');
var request = require('request');
var jf = require('jsonfile');
var URL = require('url');
var webdriver = require('selenium-webdriver');
var until = require('selenium-webdriver').until;

var utils = require('./utils');

until.urlStartsWith = function urlStartsWith(base_url) {
    base_url = URL.parse(base_url);
    return new until.Condition(
        '',
        function (driver) {
            return driver.getCurrentUrl().then(function (current_url) {
                current_url = URL.parse(current_url);
                return current_url.protocol === base_url.protocol &&
                    current_url.host === base_url.host &&
                    current_url.pathname === base_url.pathname;
            });
        }
    );
};

var get_final_token_using_password_credentials = function get_final_token_using_password_credentials(grunt, instance_name, instance_info, url, username, password, redirect_uri) {
    return new Promise(function (resolve, reject) {
        var body = {
            'grant_type': 'password',
            'redirect_uri': redirect_uri,
            'username': username,
            'password': password
        };

        // Required for KeyRock 2.0
        var headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + new Buffer(instance_info.client_id + ":" + instance_info.client_secret).toString('base64')
        };

        grunt.log.debug('Basic auth: ' + headers.Authorization);
        grunt.log.verbose.writeln('Requesting final token to ' + url + ' ...');
        request.post({url: url, headers: headers, form: body}, function (error, response, body) {
            if (error) {
                reject(error);
                return;
            }

            if (response.statusCode === 401) {
                reject('Invalid username or password');
                return;
            } else if (response.statusCode !== 200) {
                reject('Unexpected response from server');
                return;
            }

            var config = utils.read_config();
            var token_info = JSON.parse(body);
            instance_info.token_info = token_info;
            grunt.log.debug('Token Info: ' + JSON.stringify(token_info));

            config.hosts[instance_name].token_info = token_info;
            //

            jf.writeFileSync(utils.get_config_file_name(), config);

            resolve(instance_info);
        });
    });
};

var get_final_token = function get_final_token(grunt, instance_name, instance_info, url, code, redirect_uri, resolve, reject) {
    var body = {
        'code': code,
        'grant_type': 'authorization_code',
        'client_id': instance_info.client_id,
        'client_secret': instance_info.client_secret,
        'redirect_uri': redirect_uri
    };

    // Required for KeyRock 2.0
    var headers = {
        'Authorization': 'Basic ' + new Buffer(instance_info.client_id + ":" + instance_info.client_secret).toString('base64')
    };

    grunt.log.verbose.writeln('Requesting final token...');
    request.post({url: url, headers: headers, form: body}, function (error, response, body) {
        if (error) {
            reject(error);
            return;
        }

        if (response.statusCode !== 200) {
            reject('Unexpected response from server');
            return;
        }

        var token_info = JSON.parse(body);
        instance_info.token_info = token_info;
        grunt.log.debug('Token Info: ' + JSON.stringify(token_info));

        // Store auth info
        var config = utils.read_config();

        config.hosts[instance_name].token_info = token_info;
        jf.writeFileSync(utils.get_config_file_name(), config);
        //

        resolve(instance_info);
    });
};


var auth = function auth(grunt, instance_name, instance_info) {

    return new Promise(function (resolve, reject) {
        request.get(URL.resolve(instance_info.url, '.well-known/oauth'), function (error, response, body) {
            if (error || response.statusCode !== 200) {
                reject();
                return;
            }

            var info = JSON.parse(body);
            var redirect_uri;

            if (Array.isArray(info.flows) && info.flows.indexOf("Resource Owner Password Credentials Grant") !== -1) {
                var questions = [
                    {
                        type: "input",
                        name: "username",
                        message: "Username:",
                        validate: utils.validate_no_empty
                    },
                    {
                        type: "password",
                        name: "password",
                        message: "Password:"
                    }
                ];

                grunt.log.writeln();
                inquirer.prompt(questions, function (answers) {
                    get_final_token_using_password_credentials(grunt, instance_name, instance_info, info.token_endpoint, answers.username, answers.password, redirect_uri).then(resolve, reject);
                });

            } else {
                redirect_uri = instance_info.redirect_uri;
                if (redirect_uri == null) {
                    redirect_uri = info.default_redirect_uri;
                }

                var auth_url = info.auth_endpoint + '?response_type=code&client_id=' + encodeURIComponent(instance_info.client_id) + '&redirect_uri=' + encodeURIComponent(redirect_uri);

                grunt.log.verbose.writeln("Redirect uri: " + redirect_uri);
                grunt.log.verbose.writeln("Redirecting to: " + auth_url);
                var driver = new webdriver.Builder()
                    .forBrowser('firefox')
                    .build();

                driver.get(auth_url);
                driver.wait(until.urlStartsWith(redirect_uri), 24*60*60*1000);
                driver.getCurrentUrl().then(function (current_url) {
                    driver.quit();
                    current_url = URL.parse(current_url, true);
                    var code = current_url.query.code;
                    grunt.log.debug('Code: ' + code);
                    get_final_token(grunt, instance_name, instance_info, info.token_endpoint, code, redirect_uri, resolve, reject);
                }, reject);
            }
        });
    });

};

var create_instance_interactive = function create_instance_interactive(grunt, instance_name) {
    return new Promise(function (resolve, reject) {
        var questions = [
            {
                type: "input",
                name: "url",
                message: "WireCloud instance url:",
                default: "https://mashup.lab.fiware.org"
            },
            {
                type: "input",
                name: "client_id",
                message: "OAuth2 Client Id:",
                validate: utils.validate_no_empty
            },
            {
                type: "input",
                name: "client_secret",
                message: "OAuth2 Client Secret:",
                validate: utils.validate_no_empty
            }
        ];

        inquirer.prompt(questions, function (answers) {
            var instance_info = {
                url: answers.url,
                client_id: answers.client_id,
                client_secret: answers.client_secret
            };

            // Store auth info
            var config = utils.read_config();
            if (typeof config.hosts !== 'object') {
                config.hosts = {};
            }

            config.hosts[instance_name] = instance_info;
            jf.writeFileSync(utils.get_config_file_name(), config);
            //

            resolve(instance_info);
        });
    });
};

var get_token = function get_token(grunt, instance_name) {

    return new Promise(function (resolve, reject) {
        var config = utils.read_config();
        if (typeof config.hosts === 'object' && typeof config.hosts[instance_name] === 'object') {
            var instance_info = config.hosts[instance_name];
            if (typeof instance_info.token_info === 'object' && typeof instance_info.token_info.access_token === 'string') {
                resolve(instance_info);
            } else {
                auth(grunt, instance_name, instance_info).then(resolve, reject);
            }
        } else {
            grunt.log.writeln("\n");
            grunt.log.writeln(instance_name + " instance is not configured. Creating the new instance:");
            create_instance_interactive(grunt, instance_name).then(function (instance_info) {
                auth(grunt, instance_name, instance_info).then(resolve, reject);
            }, reject);
        }
    });
};
module.exports.get_token = get_token;