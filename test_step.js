const text = "1. **Resources & References/Resources/Google Keep/Dream??.md**";
const NOTE_PATH_RE = /(?:[^\/\n\r"*<>|?]+\/)*[^\/\n\r"*<>|?]+\.md/g;
console.log(NOTE_PATH_RE.exec(text));
