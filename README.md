# Hetzner Cloud On Demand Servers

This is a tool that allows you to save all servers in a hetzner project as a snapshot and remove them. 
Later you can rebuild the servers from the snapshot.

This is usefull for example, when you have a development environment on Hetzner servers, that do not have to be up 24/7.
So you can save costs by only starting it when you need it.

One downside is, that you get a new ip address assigned everytime.
Because of this, the tool automatically updates DNS records via Hetzer DNS to always match the server name to a subdomain.

## Setup
1. Create a project in Hetzner Cloud console
2. Add an SSH Key named "default" to you project using the smallest instance type (CX11) (if 20GB of storage are enough for you)
3. Manually create as many servers as needed.
4. Create an API token with read and write permissions for your project (Security > Tokens) and note it down
5. Make sure your Testing Domain uses Hetzner DNS, and note the Zone ID (from URL)
6. Create an API token for Hetzner DNS (https://dns.hetzner.com/settings/api-token)
7. Clone this repo
8. Copy the .env.example file and adjust it.


## Shutdown servers
Run the following command:
```
node index.js stop
```

This command will:
1. Stop all servers in the project
2. Create snapshots of all servers in the project
3. ! Delete all servers in the project
4. ! Delete all snapshots in the project that were previously existing


## Start servers
Run the following command:
```
node index.js start
```

This command will:
1. Create servers for all snapshots in the project, using the smallest possible server type from config
2. Rescale all servers to the server type from config, without increasing disk size
3. Add one DNS record for each server in the zone and with the suffix specified in config
4. ! Delete all other DNS A-records from this zone, that have the specified suffix.
