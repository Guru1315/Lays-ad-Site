# Prompts

These are the prompts used to build and ship this project with [Claude Code](https://claude.com/claude-code), copied word for word and in order. The notes under each one say what it led to.

Housekeeping prompts in between (freeing disk space, clearing caches) are left out because they did not change the site.

---

### 1. Start the rebuild

```text
/clone-website https://github.com/alagappan567/lays-crunch-experience
```

The reference repo holds only docs and six screenshots: no source code and no live site. Claude read the README, pseudocode and screenshots, wrote a build brief, and mapped every section to a component.

### 2. Build from the docs alone

```text
i not have live site so build from that repos information and with those files
```

Claude built the whole page from the docs and screenshots:

- Preloader with a chip storm
- 3D bag carousel on an arc, with flavor rings behind it
- Story section: four pinned chapters with callouts
- Chip storm
- The Wall
- Build-a-Box 3-pack
- The Rack, with a drag wheel
- Q&A and Join

Pack art and the 3D bags are generated in the browser (canvas textures on pillow meshes with crimped seals), so the build ships no product photos.

### 3. Check it against the screenshots

```text
Yes, check it
```

Claude compared the build with the reference screenshots section by section, using headless Chrome, and fixed the layout bugs it found (hero title overlap, story label overflow, Rack fitting one screen, washed-out bags). It wrote 17 automated interaction checks and cut load time from about 24 s to 7–9 s by sharing one WebGL renderer and drawing bag images straight to canvas. It then fixed the phone layouts, the header color over light sections, and the Rack's "TASTE IT" button being covered on phones.

### 4. Ship it

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
