const file = { path: 'Resources & References/Resources/Google Keep/Dream??.md', name: 'Dream??.md' };
const rawPath = 'Resources & References/Resources/Google Keep/Dream??.md';
const toKey = (value) => value.replace(/\\/g, '/').normalize('NFC').toLowerCase();
const toLooseKey = (value) => 
  value.replace(/\\/g, '/').normalize('NFC').toLowerCase()
    .replace(/[\s'"`.,;:!?()[\]{}]/g, '').replace(/[\u200B-\u200D\uFEFF]/g, '');

const cKey = toKey(rawPath);
const cLoose = toLooseKey(rawPath);
const files = [file];
for (const f of files) {
  const fKey = toKey(f.path);
  const fLoose = toLooseKey(f.path);
  if (fKey.endsWith(cKey) || cKey.endsWith(fKey)) console.log("MATCH 1");
  if (fLoose.endsWith(cLoose) || cLoose.endsWith(fLoose)) console.log("MATCH 2");
}
