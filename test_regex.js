const text = '1.  **Resources & References/Resources/Google Keep/Dream??.md**: It mentions...';
const re = /(?:[^\/\n\r"*<>|?]+\/)*[^\/\n\r"*<>|?]+\.md/g;
console.log(text.match(re));
console.log(text.match(/[^\/\n\r"*<>|?]+\.md/g));
console.log("Resources & References/Resources/Google Keep/Dream??.md".match(re));
console.log("Dream??.md".match(re));
