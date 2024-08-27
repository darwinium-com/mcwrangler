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

**Note** the wrangler.toml files of existing workers **may** be modified!
Darwinium must know about any existing Cloudflare workers in order to set correct routes on Darwinium workers and in some rare cases, adjust routes for existing workers where the routes overlap.
Modification of the existing worker wrangler.toml file will only occur when a Darwinium worker route exactly matches an existing worker’s path route and deploying would cause a conflict.
In this situation, there is a known issue in that formatting and comments will be lost.
We would recommend checking carefully and selectively reverting changes with a graphical diff editor.

MCWrangler is therefore designed to be integrated with your existing "Infrastructure as Code" and the generated output files committed into source control along-side existing workers.

The file `existing_workers.json` must be updated to specify the absolute path to the wrangler toml file for each existing worker. This can be done with either one entry per toml file:
`"test/some/obscure/path/my-first-worker/wrangler.toml"`

 or a wildcard entry:
`"/Users/foobar/dev/mcwrangler/test/**/wrangler.toml"`

Once the existing workers have all been added, the deployment procedure is as follows:
- Run MCWrangler. **Note** the wrangler.toml files of existing workers **may** be modified! This should not be an issue under normal circumstances as the original copy would reside in source control.
- Deploy existing workers, inclusive of modified routes once reviewed and approved.
- Deploy Darwinium workers using the instructions output from MCWrangler.
- Commit relevant artifacts to source control. This includes the wrangler.toml files of existing workers if modified.

