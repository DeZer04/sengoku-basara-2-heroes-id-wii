# Sengoku Basara 2 Heroes — Terjemahan Bahasa Indonesia

> **Repo uji coba versi Wii.** Salinan dari [DeZer04/sengoku-basara-2-heroes-id](https://github.com/DeZer04/sengoku-basara-2-heroes-id)
> ditambah patcher Wii (RBSJ08): **https://dezer04.github.io/sengoku-basara-2-heroes-id-wii/patcher-wii.html**
> File patch Wii belum dirilis publik; tester mendapatkannya langsung dari DeZer04. Game harus dalam format RVZ
> (ubah di Dolphin: Convert File → RVZ, Zstandard).

Patch terjemahan penggemar untuk **Sengoku Basara 2 Heroes** (PlayStation 2, Jepang, SLPM-66848).
Patched by **DeZer04**.

**Halaman unduh & patcher online: https://dezer04.github.io/sengoku-basara-2-heroes-id/**

> **GRATIS.** Patch ini dibagikan gratis di halaman ini. Kalau kamu membayar untuk mendapatkannya, kamu tertipu.
> Dilarang menjual patch ini maupun ISO hasil patch.

Paket ini **tidak berisi game**. Kamu wajib punya ISO sendiri yang di-dump dari disk aslimu. Jangan minta atau
membagikan file ISO. Semua hak atas game, karakter, gambar dan musik milik CAPCOM.

## Unduh

Ambil file dari halaman **[Releases](../../releases/latest)**:

| File | Isi |
|---|---|
| `basara2_id_v0.98.patch` / `.xdelta` | terjemahan saja (disarankan) |
| `basara2_id_v0.98_koban10.patch` / `.xdelta` | terjemahan + koban (uang) ×10 |

Format `.patch` dipakai dengan `patcher.html` (browser) atau `apply_patch.py`; format `.xdelta` dengan xdelta UI,
DeltaPatcher atau `xdelta3`. Hasil keduanya identik.

## ISO yang dibutuhkan

Sengoku Basara 2 - Heroes (Japan) — dump Redump, satu file `.iso`

| | |
|---|---|
| Ukuran | 4.677.795.840 byte |
| CRC32 | `23716FDA` |
| MD5 | `B684898977107972D31BA3DFEE591F31` |
| SHA-1 | `96F0C5894ED98CDCCD6EBE10FF60B32D6BDEE2C8` |

Checksum ISO hasil patch ada di [`checksums.txt`](checksums.txt).

## Cara memasang

1. **patcher.html** (Windows, macOS, Linux, Android): buka [`patcher.html`](patcher.html) di Chrome/Edge (atau
   Firefox/Safari), pilih ISO asli dan file `.patch`, lalu klik *Patch sekarang*. Semua proses berjalan di perangkatmu;
   tidak ada file yang diunggah.
2. **xdelta**: `xdelta3 -d -s "ISO asli.iso" basara2_id_v0.98.xdelta "ISO hasil.iso"`
3. **Python**: `python apply_patch.py "ISO asli.iso" "ISO hasil.iso" basara2_id_v0.98.patch`

Mainkan ISO hasil patch di PCSX2, ARMSX2 / AetherSX2 / NetherSX2, atau PS2 asli lewat OPL. Save memory card versi
Jepang tetap bisa dipakai.

## Yang sudah diterjemahkan

Semua teks sistem dan dialog cerita, menu, nama, judul stage, spanduk pertempuran, kartu MENANG, combo, deskripsi
494 senjata/zirah/aksesori, 30 video pembuka bab, video pembuka game, video promo Turnamen Besar dan Laga Sengit,
serta video Penyatuan Negeri. Daftar lengkap, catatan versi dan masalah yang diketahui ada di
[`README_ID.txt`](README_ID.txt).

## Laporkan bug

Buka [Issues](../../issues) dengan screenshot dan lokasi kejadian (mode, stage, menu).

## Kredit

Penerjemah, teknis & pengujian: **DeZer04**. Terima kasih kepada CAPCOM, tim PCSX2, dan komunitas PS2 Indonesia.
