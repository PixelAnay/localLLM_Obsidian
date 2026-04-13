const str1 = '1.  **Resources & References/Resources/Google Keep/Dream🤤.md**: It mentions...';
const str2 = '**Resources & References/Resources/Google Keep/Dream🤤.md**';
const str3 = 'Health/Health Diary/03 May,25 - Health Journal.md';

const NOTE_PATH_RE = /(?:[^/\n\r"*<>|?]+\/)*[^/\n\r"*<>|?]+\.md/gu;

console.log('Str1:', [...str1.matchAll(NOTE_PATH_RE)].map(m => m[0]));
console.log('Str2:', [...str2.matchAll(NOTE_PATH_RE)].map(m => m[0]));
console.log('Str3:', [...str3.matchAll(NOTE_PATH_RE)].map(m => m[0]));