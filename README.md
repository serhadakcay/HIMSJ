# NexusChat v13 Render Ready

* `db.js` satır 205'teki `text.replace(/=\r?\n/g, '')` düzenli ifadesi (RegExp) ham kaçış dizileriyle (`\r?\n`) düzeltildi ve Render.com üzerinde `node --check db.js` ile doğrulandı.
