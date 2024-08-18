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

module.exports = {
  getExistingWorkers
}

