const str1 = '1.  **Resources & References/Resources/Google Keep/Dream🤤.md**: It mentions...';

const NOTE_PATH_RE = /(?:[^/\n\r"*<>|?]+\/)*[^/\n\r"*<>|?]+\.md/g;

console.log('Str1 (no u):', [...str1.matchAll(NOTE_PATH_RE)].map(m => m[0]));
