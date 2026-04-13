const text = "1. **Resources & References/Resources/Google Keep/Dream??.md**";
const NOTE_PATH_RE = /(?:[^\/\n\r"*<>|?]+\/)*[^\/\n\r"*<>|?]+\.md/g;
console.log([...text.matchAll(NOTE_PATH_RE)].map(m=>m[0]));
