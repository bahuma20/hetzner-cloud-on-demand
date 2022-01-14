import HetznerCloud from "hcloud-js";
import cliProgress from "cli-progress";
import minimist from "minimist";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const CLOUD_TOKEN = process.env.CLOUD_API_TOKEN;
const DNS_TOKEN = process.env.DNS_API_TOKEN;
const DNS_ZONE = process.env.DNS_ZONE;
const DNS_SUFFIX = process.env.DNS_SUBDOMAIN_SUFFIX;

const client = new HetznerCloud.Client(CLOUD_TOKEN);

const waitForActionsToComplete = async(actions) => {
    return new Promise((resolve, reject) => {
        const checkStatus = () => {
            setTimeout(async () => {
                actions = await Promise.all(actions.map(action => client.actions.get(action.id)));

                actions.forEach((action, i) => {
                    if (action.status == "running") {
                        bars[i].update(action.progress, {actionNumber: i+1, actionCommand: action.command, actionResourceId: action.resources[0].id, status: "running"})
                    }
        
                    if (action.status == "success") {
                        bars[i].update(100, {actionNumber: i+1, actionCommand: action.command, actionResourceId: action.resources[0].id, status: "success"})
                    }
        
                    if (action.status == "error") {
                        bars[i].update(100, {actionNumber: i+1, actionCommand: action.command, actionResourceId: action.resources[0].id, status: "error"})
                    }            
                })

                if (actions.map(action => action.status).filter(status => status == "running").length > 0) {
                    checkStatus();
                } else  {
                    // Finished

                    if (actions.map(action => action.status).filter(status => status == "error").length > 0) {
                        // With error
                        reject("Error while executing actions");
                    } else {
                        // Without error
                        multibar.stop();
                        resolve();
                    }
                }
            }, 1000)
        }

        const multibar = new cliProgress.MultiBar({
            clearOnComplete: false,
            hideCursor: true,
            format: (options, params, payload) => {
                function formatBar(progress, options){
                    // calculate barsize
                    const completeSize = Math.round(progress*options.barsize);
                    const incompleteSize = options.barsize-completeSize;
                
                   // generate bar string by stripping the pre-rendered strings
                   return   options.barCompleteString.substr(0, completeSize) +
                            options.barGlue +
                            options.barIncompleteString.substr(0, incompleteSize);
                }

                return `[${formatBar(params.progress, options)}] ${Math.floor(params.progress*100) + ''}% - #${payload.actionNumber} ${payload.actionCommand} "${payload.actionResourceId}" - ${payload.status ? payload.status.toUpperCase() : ''}`
            }
        }, cliProgress.Presets.shades_grey);

        const bars = actions.map(action => multibar.create(100, 0));
        checkStatus();
    })
    
}

const shutdown = async () => {
    try {
        const resp = await client.images.list({
            type: 'snapshot'
        });
        const oldImages = resp.images;

        const { servers } = await client.servers.list();

        if (servers.length == 0) {
            throw new Error('No servers to stop. Aborting to avoid deleting snapshots');
        }

        console.log('Stopping servers');
        await waitForActionsToComplete(await Promise.all(servers.map(server => server.shutdown())));

        console.log('Servers stopped');

        console.log('Creating snapshots of servers');
        const responses = await Promise.all(servers.map(server => server.createImage('snapshot', server.name)));
        await waitForActionsToComplete(responses.map(response => response.action));
        console.log('Snapshots created');

        console.log(`Delete servers`);
        await waitForActionsToComplete(await Promise.all(servers.map(server => client.servers.delete(server.id))));
        console.log('Servers deleted');

        console.log(`Delete old images`);
        await Promise.all(oldImages.map(image => image.delete()));
        console.log(`Deleted these images: `);
        console.log(oldImages.map(image => image.id));

        console.log('-- Success. Everything is backuped and shut down. You are saving costs! ---')


    } catch (e){
        console.error(e)
    };
}

const startup = async () => {
    try {
        const runningServersResponse = await client.servers.list();
        const runningServers = runningServersResponse.servers;

        if (runningServers.length > 0) {
            throw new Error('There are already some servers running. Aborting to avoid complications. Make sure that you stop servers first');
        }

        const {images} = await client.images.list({
            type: 'snapshot'
        });

        console.log('creating servers with smallest possible disk size')
        const responses = await Promise.all(images.map(image => client.servers.build(image.createdFrom.name)
            .serverType(process.env.SMALLEST_POSSIBLE_SERVER_TYPE)
            .location(process.env.INSTANCE_REGION)
            .image(image)
            .sshKey(process.env.SSK_KEY_NAME)
            .startAfterCreate(false)
            .create()));
        
        const temporaryServers = responses.map(response => response.server);
        const actions = responses.map(response => response.action);

        await waitForActionsToComplete(actions);

        console.log('servers created');

        console.log('rescale servers without increasing the disk size');
        const servers = await Promise.all(temporaryServers.map(server => client.servers.get(server.id)));

        await waitForActionsToComplete(await Promise.all(servers.map(server => server.changeType(process.env.SERVER_TYPE, false))));
        console.log('rescaling complete');

        const dnsRecords = {};

        servers.forEach(server => {
            dnsRecords[server.name] = server.publicNet.ipv4.ip;
        });

        await updateDnsRecords(dnsRecords);


        // Load information about DNS zone for succes message
        const zoneInfo = await fetch(`https://dns.hetzner.com/api/v1/zones/${DNS_ZONE}`, {
            headers: {
                'Auth-API-Token': DNS_TOKEN
            }
        }).then(response => response.json())


        // Success message
        console.log('-- Success. You can work now. Here are your servers: ---')
        console.log(servers.map(server => {
            return `Server "${server.name}": ${server.name}${DNS_SUFFIX}.${zoneInfo.zone.name} (${server.publicNet.ipv4.ip})`;
        }));


    } catch (e){
        console.error(e)
    };

    
}

const updateDnsRecords = async (servers) => {
    try {
        console.log('starting DNS upgrades')
        const targetRecords = Object.keys(servers).map(name => `${name}${DNS_SUFFIX}`);

        // Get all current records
        const data = await fetch(`https://dns.hetzner.com/api/v1/records?zone_id=${DNS_ZONE}`, {
            headers: {
                'Auth-API-Token': DNS_TOKEN
            }
        }).then(response => response.json());
    

        // Delete records that should not exist anymore
        let oldRecords = data.records.filter(record => {
            return record.type == 'A' && record.name.endsWith(DNS_SUFFIX) && targetRecords.indexOf(record.name) == -1;
        });

        console.log(`Deleting ${oldRecords.length} old DNS record(s)`);
        await Promise.all(oldRecords.map(record => {
            return fetch(`https://dns.hetzner.com/api/v1/records/${record.id}`, {
                method: 'DELETE',
                headers: {
                    'Auth-API-Token': DNS_TOKEN
                }
            });
        }));


        // Update existing records
        let existingRecords = data.records.filter(record => {
            return record.type == 'A' && record.name.endsWith(DNS_SUFFIX) && targetRecords.indexOf(record.name) !== -1;
        });

        const updatedRecords = existingRecords.map(record => {
            record.value = servers[record.name.replace(DNS_SUFFIX, '')];
            return record;
        });

        console.log(`Updating ${updatedRecords.length} existing DNS record(s)`);
        await fetch(`https://dns.hetzner.com/api/v1/records/bulk`, {
            method: 'PUT',
            headers: {
                'Auth-API-Token': DNS_TOKEN,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                records: updatedRecords,
            }),
        });


        // Add missing records
        let missingRecords = targetRecords.filter(record => {
            let existingNames = data.records.map(rec => rec.name);
            return existingNames.indexOf(record) == -1;
        });

        const newRecords = missingRecords.map(record => {
            return {
                name: record,
                ttl: 60,
                type: 'A',
                value: servers[record.replace(DNS_SUFFIX, '')],
                zone_id: DNS_ZONE,
            };
        });

        console.log(`Creating ${newRecords.length} new DNS record(s)`);
        await fetch(`https://dns.hetzner.com/api/v1/records/bulk`, {
            method: 'POST',
            headers: {
                'Auth-API-Token': DNS_TOKEN,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                records: newRecords,
            }),
        });

        console.log('finished DNS updates')


    } catch (e) {
        console.error(e);
    }
}

const run = async () => {

    var argv = minimist(process.argv.slice(2));

    switch (argv._[0]) {
        case "start": 
            startup();
            break;

        case "stop":
            shutdown();
            break;

        default:
            console.error("Missing action. Provide 'start' or 'stop'");
    }

    //shutdown();
    //startup();
}


run();