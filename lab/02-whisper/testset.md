# Test set: three short LibriVox recordings

Built by build-testset.ts from its sources on 2026-11-01. Don't edit this file or testset.json by hand.

**How each recording was chosen.** The first reader on the work's LibriVox catalog page whose recording runs between one and two minutes. That rule picks the reader, so nobody picked a voice that suits a model.

**Licence.** LibriVox's catalog pages state its recordings are in the public domain in the USA, and each archive.org item names its licence below. The texts are public domain works, taken from Project Gutenberg. Outside the USA, check your own country's rules. Only metadata and text live in this repo; the audio is downloaded into lab/.work/ when the lab runs.

**The spoken preamble and closing.** The files are uploaded whole, the way a user's file would be, so LibriVox's spoken preamble and closing reach the model. The published text doesn't have them. The lab scores the unbroken run of transcript words that fits the whole published text best and leaves out the words on either side of it, for both models alike. Every published word still counts. wer.ts defines this and its tests pin it down.

## Local check of the audio

Nobody listened to these files by ear, so on 2026-11-01 each one went through Xenova/whisper-base.en on the CPU, in the sandbox, with no API call and no key, cut at its silences into pieces of up to 25 seconds. It's a stand-in for listening: it shows that each file holds the published text, and which words the lab's rule leaves out. Its rates mix that small model's own mistakes with anywhere a reader departs from the printed text, so they say nothing about OpenAI's models and appear in no pull request. Any place a reader does depart from the text raises both models' numbers alike. The full transcripts are in testset-check.json.

## The Gettysburg Address, by Abraham Lincoln

- Reader: Shurtagal
- Length: 01:40 (100 s, archive.org metadata for this file)
- LibriVox catalog page: https://librivox.org/the-gettysburg-address-by-abraham-lincoln/
- Audio licence, from the archive.org item: http://creativecommons.org/licenses/publicdomain/
- archive.org item: https://archive.org/details/gettysburg_shurtagal_librivox
- Audio file: https://archive.org/download/gettysburg_shurtagal_librivox/Gettysburg_Address_Lincoln_64kb.mp3
- Audio sha1: ed8e8827bafd3cd1983500012ba27ecea4539faf (803444 bytes)
- Published text: https://www.gutenberg.org/ebooks/4
- About the text: The text LibriVox's catalog page links to. Prose, and the only one of the three that isn't verse.
- Local check, word error rate under the lab's rule: 6.3%
- Local check, words left out before the text: "this is the liberty box recording all the liberty box recording from the public domain to find out more or see how you can volunteer please visit liberty boxorg the gettysburg address by abraham lincoln on november 19th 1863"
- Local check, words left out after the text: "and if the guest burgers rests you"

Published text, as compared:

```text
Four score and seven years ago, our fathers brought forth
upon this continent a new nation:  conceived in liberty, and
dedicated to the proposition that all men are created equal.

Now we are engaged in a great civil war. . .testing whether
that nation, or any nation so conceived and so dedicated. . .
can long endure.  We are met on a great battlefield of that war.

We have come to dedicate a portion of that field as a final resting place
for those who here gave their lives that this nation might live.
It is altogether fitting and proper that we should do this.

But, in a larger sense, we cannot dedicate. . .we cannot consecrate. . .
we cannot hallow this ground.  The brave men, living and dead,
who struggled here have consecrated it, far above our poor power
to add or detract.  The world will little note, nor long remember,
what we say here, but it can never forget what they did here.

It is for us the living, rather, to be dedicated here to the unfinished
work which they who fought here have thus far so nobly advanced.
It is rather for us to be here dedicated to the great task remaining
before us. . .that from these honored dead we take increased devotion
to that cause for which they gave the last full measure of devotion. . .
that we here highly resolve that these dead shall not have died in vain. . .
that this nation, under God, shall have a new birth of freedom. . .
and that government of the people. . .by the people. . .for the people. . .
shall not perish from this earth.
```

## In Flanders Fields, by John McCrae

- Reader: Algy Pug
- Length: 01:06 (66 s, archive.org metadata for this file)
- LibriVox catalog page: https://librivox.org/in-flanders-fields-by-john-mccrae-2/
- Audio licence, from the archive.org item: http://creativecommons.org/publicdomain/mark/1.0/
- archive.org item: https://archive.org/details/inflandersfields_1411.poem_librivox
- Audio file: https://archive.org/download/inflandersfields_1411.poem_librivox/flandersfields_mccrae_alp_64kb.mp3
- Audio sha1: a6b1d3bdd2c1d2670872e51b5e24c9b89fd0da1c (530432 bytes)
- Published text: https://www.gutenberg.org/ebooks/353
- About the text: The text LibriVox's catalog page links to.
- Local check, word error rate under the lab's rule: 1.0%
- Local check, words left out before the text: "in flanders fields by john mccray retro libbyboxorg by algie pug"
- Local check, words left out after the text: "end of poem this recording is in the public domain"

Published text, as compared:

```text
In Flanders fields the poppies blow
Between the crosses, row on row,
That mark our place; and in the sky
The larks, still bravely singing, fly
Scarce heard amid the guns below.

We are the Dead.  Short days ago
We lived, felt dawn, saw sunset glow,
Loved and were loved, and now we lie,
In Flanders fields.

Take up our quarrel with the foe:
To you from failing hands we throw
The torch; be yours to hold it high.
If ye break faith with us who die
We shall not sleep, though poppies grow
In Flanders fields.
```

## Ozymandias of Egypt, by Percy Bysshe Shelley

- Reader: Alan Davis Drake (1945-2010)
- Length: 01:28 (88 s, archive.org metadata for this file)
- LibriVox catalog page: https://librivox.org/ozymandias-of-egypt-by-percy-bysshe-shelley/
- Audio licence, from the archive.org item: http://creativecommons.org/licenses/publicdomain/
- archive.org item: https://archive.org/details/ozymandias_librivox
- Audio file: https://archive.org/download/ozymandias_librivox/ozymandias_of_egypt_shelley_add_64kb.mp3
- Audio sha1: 75d4c875ae62fafff2a42940711b15b16cdd648a (705156 bytes)
- Published text: https://www.gutenberg.org/ebooks/4800
- About the text: LibriVox's catalog page links only to its own recording, so this is Thomas Hutchinson's edition of Shelley on Project Gutenberg, without its editor's line numbers.
- Local check, word error rate under the lab's rule: 11.7%
- Local check, words left out before the text: "ozzimandis of egypt by percy biss shelley redforlebravoxorg by alan davis drake"
- Local check, words left out after the text: "way end of poem this recording is in the public domain"

Published text, as compared:

```text
I met a traveller from an antique land
Who said: Two vast and trunkless legs of stone
Stand in the desert...Near them, on the sand,
Half sunk, a shattered visage lies, whose frown,
And wrinkled lip, and sneer of cold command,
Tell that its sculptor well those passions read
Which yet survive, stamped on these lifeless things,
The hand that mocked them, and the heart that fed:
And on the pedestal these words appear:
‘My name is Ozymandias, king of kings:
Look on my works, ye Mighty, and despair!’
Nothing beside remains. Round the decay
Of that colossal wreck, boundless and bare
The lone and level sands stretch far away.
```
