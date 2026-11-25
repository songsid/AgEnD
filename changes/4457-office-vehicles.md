---
section: Added
---
- Office skin packs may add `vehicles` (up to 4): a train or bus that goes round a closed path on its own, stopping at stops, with a picture per heading and seats that turn with it. An agent rides one with `office_set { ride }`: it walks to a platform, boards only while the vehicle is stopped, rides, and gets off at a stop when the ride ends. Packs without `vehicles` are unchanged.
- The Office draws less per frame on big maps with many people: the foreground is painted once into a layer, the canvas is at most 2 px per CSS px, people off screen are skipped, and while anything moves it redraws at most 30 times a second. On a 5120×2880 pack with 22 people and a train, an emulated phone's main thread went from 100% to 50% busy.
