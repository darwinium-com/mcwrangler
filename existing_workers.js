const fs = require('fs');
const wcmatch = require('wildcard-match');
const _ = require('lodash');
const path = require('node:path');
const { readdir } = require('fs').promises;
const TOML = require('smol-toml');

const findTomlFiles = async () => {
  let list = JSON.parse(fs.readFileSync('existing_workers.json'));
  async function* getFiles(dir) {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const res = path.resolve(dir, dirent.name);
      if (dirent.isDirectory()) {
        yield* getFiles(res);
      } else {
        yield res;
      }
    }
  }

  let matches = await Promise.all(list.map(async (element) => {
    let fullPath = path.resolve(element);
    let tokens = fullPath.split('/');
    let wildcardIndex = tokens.findIndex(token => token.includes('*'));
    let place = '';
    if(wildcardIndex !== -1) {
      if(path.isAbsolute(element))
        place = path.resolve(...['/',...tokens.slice(0,wildcardIndex)]);
      else
        place = path.resolve(...tokens.slice(0,wildcardIndex));
    }else{
      place = fullPath;
    }

    let matchedFiles = [];
    let matches_pattern = wcmatch(element);

    try{
      if(fs.statSync(place).isFile()){
          matchedFiles.push(place);
      }else{
        for await (const f of getFiles(place)) {
            let isMatch = matches_pattern(f);
            if(isMatch){
              matchedFiles.push(f);
            }
          }
      }
    }catch(e){}
    return matchedFiles;
  }));
  return _.uniq(_.flatten(matches));
}

const getExistingWorkers = async () => {
  let files = await findTomlFiles();
  let routes = [];
  for(let file of files){
    let data = fs.readFileSync(file, 'utf8');
    let parsed = TOML.parse(data);
    // Take a copy to see if anything has changed.
    let originalParsed = _.cloneDeep(parsed);

    // Check if there are any dwn_original_routes defined. If there are, attempt to move them back to routes to restore the original worker if needed.
    // This will cause a write if the route is not swallowed by the darwinium worker this run.
    if (parsed.env) {
      for (const key of Object.keys(parsed.env)) {
        let env_conf = parsed.env[key];
        if (env_conf.dwn_original_routes !== undefined) {
          env_conf.routes = env_conf.dwn_original_routes;
          env_conf.dwn_original_routes = undefined;
        }
      }
    }
    routes.push({file: file, parsed: parsed, originalParsed: originalParsed });
  }
  return routes;
}

const writeoutModifiedExistingWorkers = (existingWorkers) => {
  for (const worker of existingWorkers) {
    if (!_.isEqual(worker.originalParsed, worker.parsed)) {
      console.log(`Modifying existing worker: ${worker.file}`)
      fs.writeFileSync(worker.file, TOML.stringify(worker.parsed));
    }
  }
}

// Emulates Cloudflare's path matching logic to find overlapping routes.
const matchPath = (patha, pathb) => {
  const trimScheme = (path) => {
    if (path.startsWith("http://")) {
      return path.slice(7);
    }
    if (path.startsWith("https://")) {
      return path.slice(8);
    }
    return path;
  }
  
  const trimWildcards = (path) => {
    path = trimScheme(path);
    let startsWithWildcard = false;
    if (path.startsWith("*")) {
      path = path.slice(1);
      startsWithWildcard = true;
    }
    let endsWithWildcard = false;
    if (path.endsWith("*")) {
      path = path.slice(0, path.length - 1);
      endsWithWildcard = true;
    }
  
    return [path, startsWithWildcard, endsWithWildcard];
  }
  
  let [pattern, startsWithWildcard, endsWithWildcard] = trimWildcards(patha);
  let [tomatch, _a, _b] = trimWildcards(pathb);
  if (startsWithWildcard) {
    if (endsWithWildcard) {
      return tomatch.contains(pattern);
    } else {
      return tomatch.endsWith(pattern);
    }
  } else {
    if (endsWithWildcard) {
      return tomatch.startsWith(pattern);
    } else {
      return tomatch == pattern;
    }
  }
}

// Where a new worker has the exact same path as an existing worker, it will need to remove the existing
// worker's path so there is no conflict.
const removePathFromExistingWorker = (worker, envName, myRoute) => {
  if (worker.parsed.env == undefined) {
    worker.parsed.env = {};
  }
  if (worker.parsed.env[envName] === undefined) {
    worker.parsed.env[envName] = {};
  }
  if (worker.parsed.env[envName].routes === undefined) {
    worker.parsed.env[envName].routes = _.cloneDeep(workersForEnv);
  } else if (worker.parsed.env[envName].dwn_original_routes === undefined) {
    // Save a copy for when we tamper with it. Not needed if roots is global, since will be overriden env-by-env.
    worker.parsed.env[envName].dwn_original_routes = _.cloneDeep(worker.parsed.env[envName].routes);
  }

  const index = worker.parsed.env[envName].routes.indexOf(myRoute);
  if (index > -1) {
    worker.parsed.env[envName].routes.splice(index, 1);
  }
}

// Find if any existing worker would be called where this new worker is being added. If so, this worker will need to call that worker.
const findUpstreamService = (myRoutes, envName, existingWorkers) => {
  let serviceNames = myRoutes.map((myRoute) => {
    let tightestMatchName = undefined;
    let tightestMatch = undefined;
    for (let worker of existingWorkers) {
      let workersForEnv = _.get(worker.parsed, ['env', envName, 'dwn_original_routes']) ?? _.get(worker.parsed, ['env', envName, 'routes']) ?? worker.parsed.routes;
      if (workersForEnv === undefined) {
        continue;
      }
      for (const theirRoute of workersForEnv) {
        if (_.isEqual(myRoute,theirRoute)) {
          // Since path is identical to a darwinium step, we cannot have two overlapping steps. Remove this step from that.
          removePathFromExistingWorker(worker, envName, myRoute);

          // Cannot be any tighter match than this
          return worker.parsed.name;
        }
        if (matchPath(theirRoute, myRoute)) {
          // Ours is a subset of theirs
          if (tightestMatch === undefined || matchPath(tightestMatch, theirRoute)) {
            tightestMatchName = worker.parsed.name;
            tightestMatch = theirRoute;
          }
        } else if (matchPath(myRoute, theirRoute)) {
          // Theirs is a subset of ours.
          throw new Error(`Found a route where a service binding would not work:: their route: ${theirRoute}, our route: ${myRoute}`);
        }
      }
    }
    return tightestMatchName;
  });

  // A worker may have multiple routes, but only one upstream
  for (let i = 1; i < serviceNames.length; ++i) {
    if (serviceNames[i] != serviceNames[0]) {
      throw new Error(`Conflicting upstream workers: ${myRoutes[i]} -> ${serviceNames[i]} vs ${myRoutes[0]} -> ${serviceNames[0]}`);
    }
  }

  if (serviceNames.length > 0 && serviceNames[0] != undefined) {
    return `services = [{binding = "UPSTREAM_SERVICE", service = "${serviceNames[0]}"}]`;
  } else {
    return "";
  }
}

module.exports = {
  getExistingWorkers,
  writeoutModifiedExistingWorkers,
  findUpstreamService
}

