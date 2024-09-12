## MCWrangler
A command-line tool for deploying Darwinium Cloudflare build artifacts with Cloudflare's wrangler tool.

### Prerequisites
- Cloudflare account with suitable permissions to deploy workers via wrangler
- Cloudflare wrangler
- Node.js
- A valid Darwinium API mTLS certificate and corresponding private key

**Important**
If Cloudflare workers are already deployed as part the site, then MCWrangler must be aware of them! Please see the "Integration with existing Cloudflare workers" section for more information.

### Getting Started

Clone the Darwinium MCWrangler repository to a new local directory. Change into new directory and run `npm install`. 

MCWrangler is invoked by passing mcwrangler.js and parameters to node on the command line as follows:

`node mcwrangler.js <commit hash> -a <account id> -c <config file>`

**Where:**
- `<commit hash>` is the *full commit hash * of the Darwinium build artifact to be deployed. If the full commit hash is not available, it can be obtained but running `git rev-parse <short commit hash>` within a terminal within Darwinium Workspace.
- `<account id>`  is the Cloudflare Account ID to be used when invoking wrangler. 
- `<config file>` is the file name of the configuration file to use.

### Configuration

An example file `config.json` is provided demonstrating the required configuration elements.

### Output

MCWrangler outputs the commands required to deploy the provided commit hash build for each of the environments configured.
- Notify Darwinium that worker deployment is about to take place
- A series of commands to deploy each Darwinium workers using wrangler
- Notify Darwinium that deployment has completed and activate the new Darwinium Journey.

### Integration with existing Cloudflare workers
Darwinium must know about any existing Cloudflare workers in order to set correct routes on Darwinium workers and in some rare cases, adjust routes for existing workers where the routes overlap.

Darwinium's workers will call the worker that would have been called for a specific URL had the darwinium worker not been there, as if it were the origin server of a request.
It achieves this by binding this existing worker as a service binding called "UPSTREAM_SERVICE" and calling this service where it would otherwise call the origin.

To achieve this, MCWrangler is designed to be integrated with your existing "Infrastructure as Code" and the generated output files committed into source control along-side existing workers.

The file `existing_workers.json` must be updated to specify the absolute path to the wrangler toml file for each existing worker. This can be done with either one entry per toml file:
`"test/some/obscure/path/my-first-worker/wrangler.toml"`

 or a wildcard entry:
`"/Users/foobar/dev/mcwrangler/test/**/wrangler.toml"`

Upon successfully loading all paths for all existing workers, McWrangler will find the most specific existing route that overlaps with the path for the Darwinium worker, according to cloudflare's rules in [https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior], to determine which existing route would have run.
If this existing worker's route is a superset of Darwinium worker's routes, that worker will become the UPSTREAM_SERVICE for Darwinium's worker.
If this existing worker's route is a subset of Darwinium worker's routes, McWrangler will terminate with an error and you should adjust Darwinium's routes within the portal.
If this existing worker's route matches the Darwinum worker's route exactly, the existing worker will be treated as UPSTREAM_SERVICE and the route will be removed from the existing worker and transferred to the Darwinium worker. **Note** in this case the wrangler.toml files of the existing workers will be modified! There is a known issue in that formatting and comments will be lost; we recommend checking carefully and selectively reverting changes with a graphical diff editor.

Once the existing workers have all been added, the deployment procedure is as follows:
- Run MCWrangler. **Note** the wrangler.toml files of existing workers **may** be modified! This should not be an issue under normal circumstances as the original copy would reside in source control.
- Deploy existing workers, inclusive of modified routes once reviewed and approved.
- Deploy Darwinium workers using the instructions output from MCWrangler.
- Commit relevant artifacts to source control. This includes the wrangler.toml files of existing workers if modified.

