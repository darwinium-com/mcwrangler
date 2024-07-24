const TOML_BOILERPLATE = `

name = "{{WORKER_NAME}}"
account_id = "{{ACCOUNT_ID}}"

workers_dev = true
compatibility_date = "2023-12-01"
main = "worker.js"
logpush = {{LOGPUSH}}


# UPSTREAM_SERVICE is a fixed name used in cloudflare worker
# service_binding_name can be any cloudflare worker without route binding to it

[[rules]]
type = "ESModule"
globs = ["worker.js"]
fallthrough = true

[[rules]]
type = "CompiledWasm"
globs = ["*.wasm"]
fallthrough = true
`

const ENV_BOILERPLATE = `
[env.{{NODE_NAME}}]
kv_namespaces = [
{{KV}}
]
routes = {{ROUTES}}

[env.{{NODE_NAME}}.vars]
JOURNEY_ENVIRONMENT = """
{{J_ENV}}
"""
`

const fs = require('fs');
const https = require('https');
const YAML = require('yaml');
const { spawn } = require('node:child_process');
const tar = require('tar');
const path = require('path');
const { program } = require('commander');
let config;
let accountId;


const httpGetOptions = (env, url) => {
  const key = fs.readFileSync(env.cert.key);
  const cert = fs.readFileSync(env.cert.cert);
  return {
    hostname: env.dwn_api_host,
    port: 9443,
    path: url === undefined ? '/api/deployment/environment.json' : url,
    method: 'GET',
    key,
    cert,  
    passphrase: env.cert.passphrase
  };
}

const readRemote = async (env, url, outPath, commitHash) => {
  return new Promise((resolve, reject) => {
    var options = httpGetOptions(env, url);
    let req = https.request(options, function(res) {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('error', (err) => reject(err));
      res.on('end', () => {
        if(url === undefined)
          resolve(Buffer.concat(chunks).toString('utf8'))
        else {
          fs.writeFileSync(outPath, Buffer.concat(chunks));
          resolve();
        }
      });
    });
    req.end()  
  });
}

const readTar = async (env, url, outDir) => {
  spawn('sh', ['-c', `rm -rf ${outDir} && mkdir -p ${outDir}`]);
  return new Promise((resolve, reject) => {
    var options = httpGetOptions(env, url);
    let req = https.request(options, function(res) {
      if(res.statusCode !== 200) {
        //print error in red
        console.error('\x1b[31m%s\x1b[0m', `Error: ${options.hostname}:${options.port}${url} ${res.statusCode} ${res.statusMessage}`);
        process.exit(1);
      }
      const parseStream = new tar.Parser();
    
      parseStream.on('entry', (entry) => {
        const chunks = [];
        entry.on('data', (chunk) => {
          chunks.push(chunk);
        });
        entry.on('end', () => {
          if (entry.type === 'File') {
            let full_path = outDir + entry.path.slice(1);
            fs.mkdirSync(path.dirname(full_path), {recursive: true})
            fs.writeFileSync(full_path, Buffer.concat(chunks));
          }
        });
      });

      parseStream.on('end', () => {
        resolve();
      });
      parseStream.on('error', (err) => reject(err));
      res.on('error', (err) => reject(err));
      res.pipe(parseStream);
    });
    req.end()  
  });
}

const findCloudflareTargets = (inDir) => {
  let out = YAML.parse(fs.readFileSync(`${inDir}/journeys.yaml`, 'utf8'));
  let targets = {};
  for (const target of out.targets) {
    if (target.type === 'cloudflare' && target.enabled === true) {
      targets[target.name] = target;
    }
  }
  return targets;
}

const processCommit = async (envName, commitHash) => {
  const unpackDirName = `build/${envName}`;
  console.log(`\x1b[34m%s\x1b[0m`, `downloading edge bundle for commit: ${commitHash}) to: ./${unpackDirName}`);
  await readTar(config[envName],  `/api/deployment/artifacts/edge_${commitHash}.tar.gz`, unpackDirName)
  let targets = findCloudflareTargets(unpackDirName);
 
  let terminalCommands = [];
  await Promise.all(Object.entries(targets).map(async ([targetName, target]) => {
    const workers = fs.readFileSync(`${unpackDirName}/${targetName}/workers.json`, 'utf8');
    const workersJSON = JSON.parse(workers); 
    let workersRoutes = {};
    let logpush = target.logpush ?? false;

    // Load each environment being deployed to.
    let envs = {};
    for(const envName of Object.keys(config)){
      let env = JSON.parse(await readRemote(config[envName]));
      envs[envName] = env;

      let addEntry = (pattern, script_name) => {
        if(workersRoutes[script_name] === undefined) 
          workersRoutes[script_name] = {};
        if(workersRoutes[script_name][envName] === undefined) 
          workersRoutes[script_name][envName] = [];
        workersRoutes[script_name][envName].push(pattern);
      };
  
      // Substitute in per-target host aliases to make the final list of routes
      workersJSON.worker_routes.forEach((workerRoute)=> {
        let pattern = workerRoute.pattern;
        let slash_index = pattern.indexOf("/") ?? pattern.length;
        let substitution = (env.aliases ?? []).find((value) => {
          return value.alias.length === slash_index && pattern.slice(0, slash_index) === value.alias
        })
        if (substitution === undefined) {
          addEntry(pattern, workerRoute.script_name);
        } else {
          let suffix = pattern.slice(slash_index);
          for (const host of substitution.host) {
            addEntry(host + suffix, workerRoute.script_name);
          }
        }
      });
    }

    await Promise.all(Object.keys(workersRoutes).map(async (workerName) => {
      let outputHead = TOML_BOILERPLATE.replace(/{{WORKER_NAME}}/g, workerName)
      .replace(/{{LOGPUSH}}/g, logpush.toString())
      .replace(/{{ACCOUNT_ID}}/g, accountId);
    
      // Create an [env] for each instance that we're deploying to.
      let outs = {}
      for(const [envName, env] of Object.entries(envs)){
        let workerRoute = JSON.stringify(workersRoutes[workerName][envName] ?? []);
        // get KV Store entries
        let kv = Object.keys(config[envName].kv).map((kvName) => {
          return `{ binding = "${kvName}", id = "${config[envName].kv[kvName]}" },`;
        }).join('\n\t');
       
        env.target_name = targetName;
        env.worker_name = workerName;
        let out = ENV_BOILERPLATE.replace(/{{NODE_NAME}}/g, envName)
        .replace(/{{KV}}/g, kv)
        .replace(/{{J_ENV}}/g, JSON.stringify(env, null, 2))
        .replace(/{{ROUTES}}/g, workerRoute);

        if(outs[`${unpackDirName}/${targetName}/${workerName}/wrangler.toml`] === undefined) 
          outs[`${unpackDirName}/${targetName}/${workerName}/wrangler.toml`] = [];
        outs[`${unpackDirName}/${targetName}/${workerName}/wrangler.toml`].push(out);
     
      };
      
      Object.keys(outs).forEach((outPath) => {
        fs.writeFileSync(outPath, [outputHead].concat(outs[outPath]).join('\n'), "utf-8");
        terminalCommands.push(`cd ${unpackDirName}/${targetName}/${workerName} && wrangler deploy -e ${envName} && cd ../../../../`);
      });

    }));
  }));

  console.log('\n\n');
  console.log(`\x1b[1m\x1b[4m%s\x1b[0m`, `Deployment Instructions\n`);
  console.log(`\x1b[32m%s\x1b[0m`, '1. Notify Darwinium that the deployment(s) are starting:');
  Object.keys(config).forEach((envName) => {
    console.log(`curl --request PUT --cert ${config[envName].cert.cert} --key ${config[envName].cert.key} --pass ${config[envName].cert.passphrase} https://${config[envName].dwn_api_host}:9443/api/deployment/current/${commitHash} `);
  });
  console.log(`\x1b[32m%s\x1b[0m`, `2. Commands to run to deploy ${unpackDirName} using wrangler:`);
  terminalCommands.map((command) =>{
    console.log(command);
  });
  console.log(`\x1b[32m%s\x1b[0m`, '3. Notify Darwinium that the deployment(s) have finished:');
  Object.keys(config).forEach((envName) => {
    console.log(`curl --request PUT --cert ${config[envName].cert.cert} --key ${config[envName].cert.key} --pass ${config[envName].cert.passphrase} https://${config[envName].dwn_api_host}:9443/api/deployment/current/${commitHash}?mode=finished `);
  });
  
}




const main = async () => {

  program
    .name('mcwrangle')
    .description(`This tool helps to convert darwinium edge artifacts into cloudflare workers. 
To use it you will require a valid MTLS certificate/private keypair that has
been configured with access to your node.

See: https://docs.darwinium.com/docs/setting-up-certificates for details on how to set this up.`)
    .argument('<commit hash>', 'commit hash to process')
    .option('-c, --config <configfile>', 'config.json file to use')
    .requiredOption('-a, --accountid <cloudflare-account-id>', 'cloudflare account id to deploy with');
  program.parse();
  let configJson = program.getOptionValue('config') || 'config.json';
  let commitHash = program.args[0];
  if(!fs.existsSync(configJson)) {
    console.log('\x1b[31m%s\x1b[0m', `Config file not found: ${configJson}`);
    process.exit(1);
  }
  config = JSON.parse(fs.readFileSync(configJson, 'utf8'));
  const configPath = path.dirname(configJson);
  for (const entryName in config) {
    let cert = config[entryName].cert;
    cert.cert = path.join(configPath, cert.cert);
    cert.key = path.join(configPath, cert.key);
  }
  accountId = program.getOptionValue('accountid');
  
  if(commitHash.length !== 40) 
    console.log('\x1b[31m%s\x1b[0m', `Invalid commit hash: ${commitHash}`)

  let envName = Object.keys(config)[0]
  await processCommit(envName, commitHash, configJson);
  
  console.log('done');

}

main();