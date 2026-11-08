# Prompts

- Preloader with a chip storm
- 3D bag carousel on an arc, with flavor rings behind it
- Story section: four pinned chapters with callouts
- Chip storm
- The Wall
- Build-a-Box 3-pack
- The Rack, with a drag wheel
- Q&A and Join

Pack art and the 3D bags are generated in the browser (canvas textures on pillow meshes with crimped seals), so the build ships no product photos.

### 1. Check it against the screenshots

```text
Yes, check it
```

Claude compared the build with the reference screenshots section by section, using headless Chrome, and fixed the layout bugs it found (hero title overlap, story label overflow, Rack fitting one screen, washed-out bags). It wrote 17 automated interaction checks and cut load time from about 24 s to 7–9 s by sharing one WebGL renderer and drawing bag images straight to canvas. It then fixed the phone layouts, the header color over light sections, and the Rack's "TASTE IT" button being covered on phones.

### 2. Ship it

```text
deploy this on vercel and commit and push on https://github.com/Guru1315/Lays-ad-Site push only prompts and screenshots that we used on this project with 3d animated README section with live demo
```

Claude:

- Deployed the site to Vercel.
- Ran all 17 interaction checks against the live URL; all passed.
- Recorded the real 3D carousel frame by frame on a virtual clock and encoded it as `assets/hero-3d.gif`.
- Drew the animated SVG banner.
- Took fresh screenshots of the live site and wrote this repo.

[← Back to README](README.md)
