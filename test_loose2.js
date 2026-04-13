const rawPath = 'Resources &amp; References/Resources/Google Keep/Dream??.md';
const toLooseKey = (value) =>
  value.replace(/\\/g, '/')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s'"`.,;:!?()[\]{}&]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
  
console.log(toLooseKey(rawPath));
