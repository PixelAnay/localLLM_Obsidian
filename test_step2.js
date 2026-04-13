const texts = [
"Resources & References/Resources/Google Keep/Dream🤤.md",
"1. **Resources & References/Resources/Google Keep/Dream🤤.md**",
"Dream🤤.md",
"**Dream🤤.md**"
];
const NOTE_PATH_RE = /(?:[^\/\n\r"*<>|?]+\/)*[^\/\n\r"*<>|?]+\.md/g;
for (const t of texts) {
  console.log(t, '==>', t.match(/(?:[^\/\n\r"*<>|?]+\/)*[^\/\n\r"*<>|?]+\.md/g));
}
