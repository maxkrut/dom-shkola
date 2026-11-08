# Website build

- `app/static/`: website interface.
- `site-data/`: prepared data used by the website.
- `site-manifest.json`: paths, sizes and SHA-256 checksums for the build.

Official source documents and the data preparation pipeline are kept locally.
GitHub Actions runs the checks and publishes the static build to GitHub Pages.

```sh
node --throw-deprecation --test tests/*.mjs tests/*.cjs
python -W error -m unittest discover -s web-tools -p 'test_*.py'
python -W error web-tools/assemble_site.py --output build/site --built-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

The output directory must not exist. The command supplies the current UTC build
time, which is required when interface files have changed. Adding or removing
interface assets requires updating the manifest. New data requires a verified
local delivery and an updated manifest.
