# ATT&CK index

`enterprise-attack.json` is **generated**. Do not edit it by hand.

- Source: MITRE ATT&CK Enterprise STIX 2.1 bundle, <https://github.com/mitre-attack/attack-stix-data>. The version is recorded in the file (`"version"`).
- Built by `node scripts/import-attack.js enterprise-attack-NN.N.json`. It keeps technique ID, name, tactics and platforms (one technique per line, for readable diffs), plus a `revoked` map that gives the replacement ID where MITRE recorded one.
- Mappings do **not** live here. They live in each tool file (`ttps` on the tool and on presets), and the app computes the technique → tools index at load time.

© The MITRE Corporation. This work is reproduced and distributed with the permission of The MITRE Corporation. ATT&CK® is a registered trademark of The MITRE Corporation.
