const files = [
  { path: 'Resources & References/Resources/Google Keep/Dream🤤.md', name: 'Dream🤤.md' },
  { path: 'Health/Health Diary/03 May,25 - Health Journal.md', name: '03 May,25 - Health Journal.md'}
];

const resolveNoteFile = (rawPath) => {
    const candidates = new Set();
    const trimmed = (rawPath || '').trim();
    if (!trimmed) return null;

    const addCandidate = (value) => {
      const v = value.trim();
      if (!v) return;
      candidates.add(v);
      candidates.add(v.normalize('NFC'));
      candidates.add(v.normalize('NFD'));
    };

    addCandidate(trimmed.replace(/\\/g, '/'));
    addCandidate(trimmed.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
    addCandidate(trimmed.replace(/[\]\[(){}<>'"`.,;:!?]+$/, ''));
    try { addCandidate(decodeURIComponent(trimmed)); } catch(e) {}

    // Mock direct API match
    for (const candidate of candidates) {
      if (files.find(f => f.path === candidate)) return candidate;
    }

    const toKey = (value) => value.replace(/\\/g, '/').normalize('NFC').toLowerCase();
    
    // Simulate what might go wrong ...
}

console.log('Resolving exact string:', resolveNoteFile('Resources & References/Resources/Google Keep/Dream🤤.md'));
