/**
 * Unit tests for supplemental extraction coverage merging.
 */

import { describe, expect, it } from 'vitest';
import { mergeSupplementalFacts } from '../supplemental-extraction.js';
import type { ExtractedFact } from '../extraction.js';

function baseFact(overrides: Partial<ExtractedFact>): ExtractedFact {
  return {
    fact: 'As of January 2026, user is using Tailwind CSS.',
    headline: 'Uses Tailwind CSS',
    importance: 0.6,
    type: 'project',
    keywords: ['Tailwind CSS'],
    entities: [{ name: 'Tailwind CSS', type: 'tool' }],
    relations: [{ source: 'User', target: 'Tailwind CSS', type: 'uses' }],
    ...overrides,
  };
}

describe('mergeSupplementalFacts', () => {
  it('adds missing supplemental facts with new entities', () => {
    const merged = mergeSupplementalFacts(
      [],
      '[Session date: 2026-01-22]\nUser: Quick update on the finance tracker. I added Plaid integration for bank account syncing.',
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('Plaid integration'))).toBe(true);
  });

  it('keeps supplemental temporal detail when base fact lacks it', () => {
    const merged = mergeSupplementalFacts(
      [baseFact({ fact: 'As of January 15 2026, user is using Tailwind CSS for styling in the finance tracker project.' })],
      "[Session date: 2026-01-15]\nUser: Tailwind CSS. I've been using it for the last year and can't go back to regular CSS.",
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('last year'))).toBe(true);
  });

  it('keeps supplemental relative-date facts for Cat2 timing questions', () => {
    const merged = mergeSupplementalFacts(
      [baseFact({ fact: 'As of January 20 2023, user lost a job.' })],
      '[Session date: 2023-01-20]\nUser: Lost my job as a banker yesterday. Unfortunately I also lost my job at Door Dash this month.',
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('yesterday (on January 19, 2023)'))).toBe(true);
    expect(merged.some((fact) => fact.fact.includes('this month (in January 2023)'))).toBe(true);
  });

  it('does not duplicate identical facts', () => {
    const primary = baseFact({
      fact: 'As of January 22 2026, user added Plaid integration for bank account syncing.',
      headline: 'Added Plaid integration',
      keywords: ['Plaid'],
      entities: [{ name: 'Plaid', type: 'tool' }],
      relations: [{ source: 'User', target: 'Plaid', type: 'uses' }],
    });

    const merged = mergeSupplementalFacts(
      [primary],
      '[Session date: 2026-01-22]\nUser: I added Plaid integration for bank account syncing.',
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged).toHaveLength(1);
  });

  it('upgrades shorter primary facts when supplemental coverage adds project context', () => {
    const primary = baseFact({
      fact: 'As of January 22 2026, user added Plaid integration for bank account syncing.',
      headline: 'Added Plaid integration',
      keywords: ['Plaid'],
      entities: [
        { name: 'User', type: 'person' },
        { name: 'Plaid', type: 'tool' },
      ],
      relations: [{ source: 'User', target: 'Plaid', type: 'uses' }],
    });

    const merged = mergeSupplementalFacts(
      [primary],
      '[Session date: 2026-01-22]\nUser: Quick update on the finance tracker. I added Plaid integration for bank account syncing.',
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('finance tracker. I added Plaid integration'))).toBe(true);
    expect(merged.some((fact) => fact.fact === primary.fact)).toBe(false);
  });

  it('keeps literal-detail supplemental facts even without non-user entities', () => {
    const merged = mergeSupplementalFacts(
      [],
      '[Session date: 2023-02-01]\nUser: My necklace from grandma symbolizes love, faith, and strength. I found the perfect spot for my clothing store and designed the space, furniture, and decor.',
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('necklace from grandma symbolizes love, faith, and strength'))).toBe(true);
    expect(merged.some((fact) => fact.fact.includes('perfect spot for my clothing store'))).toBe(true);
  });

  it('keeps quoted literal facts that the primary extractor often drops', () => {
    const merged = mergeSupplementalFacts(
      [],
      '[Session date: 2023-09-13]\nUser: The posters at the poetry reading said "Trans Lives Matter".',
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('"Trans Lives Matter"'))).toBe(true);
  });

  it('keeps late-timeline event facts even when they have no non-user entities', () => {
    const merged = mergeSupplementalFacts(
      [baseFact({ fact: 'As of July 21 2023, user is working on a business.' })],
      [
        '[Session date: 2023-07-21]',
        'Jon: Started to learn all these marketing and analytics tools to push the biz forward today.',
        'Gina: Let\'s create some cool content and manage your social media accounts.',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('analytics tools'))).toBe(true);
    expect(merged.some((fact) => fact.fact.includes('social media accounts'))).toBe(true);
  });

  it('keeps LoCoMo temporal duration and doctor facts without named entities', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2023-05-24]',
        'Nate: I like having some of these little turtles around to keep me calm.',
        "Nate: I've had them for 3 years now and they bring me tons of joy!",
        "Sam: Thanks, Evan. Appreciate the offer, but had a check-up with my doctor a few days ago and, yikes, the weight wasn't great.",
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('Nate has had the turtles for 3 years now'))).toBe(true);
    expect(merged.some((fact) => fact.fact.includes('Sam had a check-up with Sam\'s doctor a few days ago'))).toBe(true);
  });

  it('keeps affect inventory facts even when other no-entity literal facts exist', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2022-05-04]',
        'James: By the way, today I decided to spend time with my beloved pets again.',
        'John: What else brings you happiness?',
        'James: My pets, computer games, travel and pizza are all that bring me happiness in life.',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('computer games, travel and pizza are all that bring me happiness'))).toBe(true);
  });

  it('resolves pronoun-based pet joy evidence for affect questions', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2022-05-04]',
        'James: One of them, Daisy, is a Labrador. She loves to play with her toys.',
        'John: Cool, what about the other two? Judging by the photo, shepherds?',
        'James: Exactly! You would know how much joy they bring me. They are so loyal.',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact === 'James\'s dogs bring James joy.')).toBe(true);
  });

  it('resolves pronoun-based animal motivation evidence for shared-like questions', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2022-11-04]',
        'Joanna: It was about a brave little turtle who was scared but explored the world anyway.',
        'Nate: Their resilience is so inspiring!',
        'Joanna: They make me think of strength and perseverance. They help motivate me in tough times.',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact === 'Joanna likes the animal turtles and finds them motivating.')).toBe(true);
  });

  it('backfills shared elementary-school history from class memories', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2022-07-22]',
        'John: Your support means a lot to me. Remember this photo from elementary school?',
        'James: Indeed, I remember this moment. We loved skateboards back then, sometimes we even left class early to do it.',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact === 'John and James attended elementary school and class together.')).toBe(true);
  });

  it('upgrades weaker same-shape school facts with shared class evidence', () => {
    const primary = baseFact({
      fact: 'John and James are friends who knew each other since elementary school.',
      headline: 'John and James knew each other in school',
      type: 'person',
      keywords: ['john', 'james', 'elementary', 'school'],
      entities: [
        { name: 'John', type: 'person' },
        { name: 'James', type: 'person' },
      ],
      relations: [{ source: 'John', target: 'James', type: 'knows' }],
    });

    const merged = mergeSupplementalFacts(
      [primary],
      [
        '[Session date: 2022-07-22]',
        'John: Remember this photo from elementary school?',
        'James: Indeed, I remember this moment. We loved skateboards back then, sometimes we even left class early to do it.',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact === 'John and James attended elementary school and class together.')).toBe(true);
    expect(merged.some((fact) => fact.fact === primary.fact)).toBe(false);
  });

  it('backfills shared movie and dessert interests from overlap evidence', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2022-01-21]',
        'Joanna: Besides writing, I also enjoy reading, watching movies, and exploring nature.',
        'Nate: Playing video games and watching movies are my main hobbies.',
        'Joanna: Cool, Nate! So we both have similar interests.',
        'Nate: I discovered a new way to make coconut milk ice cream.',
        'Joanna: Love your creations!',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('Joanna and Nate share an interest in watching movies.'))).toBe(true);
    expect(merged.some((fact) => fact.fact.includes('Nate and Joanna share an interest in making desserts and baking.'))).toBe(true);
  });

  it('backfills shared pet-friendly-spots frustration from empathy evidence', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2023-07-03]',
        'Andrew: I understand how it feels missing the peace of being out on the trails.',
        'Audrey: I get how frustrating it can be not to find pet-friendly spots.',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact === 'Audrey and Andrew share frustration about not being able to find pet-friendly spots.')).toBe(true);
  });

  it('backfills shared car-work activity from restoration evidence', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2023-10-04]',
        'Calvin: Also, check out this project - I love working on it to chill out.',
        '  Image caption: a photo of a shiny orange car with a hood open',
        '  Image query: sleek vintage car restoration',
        'Dave: Working on cars really helps me relax.',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('Calvin and Dave share the activity of working on cars.'))).toBe(true);
  });

  it('backfills tournament-win facts when the primary extractor misses them', () => {
    const merged = mergeSupplementalFacts(
      [baseFact({ fact: 'As of August 22 2022, Nate makes a living as a professional gamer and is passionate about his career.' })],
      [
        '[Session date: 2022-08-22]',
        'Nate: Woah Joanna, I won an international tournament yesterday! It was wild.',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('won an international tournament yesterday (on August 21, 2022)'))).toBe(true);
  });

  it('keeps competition-win facts that are embedded before a follow-up question', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2023-01-20T16:04:00.000Z]',
        'Jon: Woah, that pic\'s from when my dance crew took home first in a local comp last year. It was amazing up on that stage! Gina, you ever been in any dance comps or shows?',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('Jon\'s dance crew won first place in a local competition last year'))).toBe(true);
  });

  it('preserves image captions and visual tags as searchable evidence', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2023-07-05T18:59:00.000Z]',
        'John: Oh, and here\'s a pic I got from my walk last week.',
        '  Image caption: a photo of a sunset over the ocean with a sailboat in the distance',
        '  Image query: sunset beach colorful ocean',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    const visualFact = merged.find((fact) => fact.fact.includes('visual tags "sunset beach colorful ocean"'));
    expect(visualFact?.fact).toContain('John shared image evidence');
    expect(visualFact?.fact).toContain('a photo of a sunset over the ocean');
    expect(visualFact?.keywords).toContain('beach');
  });

  it('derives beach-walk evidence from visual tags and walk text', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2023-07-05T18:59:00.000Z]',
        'John: Here\'s a pic I got from my walk last week.',
        '  Image caption: a photo of a sunset over the ocean with a sailboat in the distance',
        '  Image query: sunset beach colorful ocean',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('John went for a walk by the beach or ocean'))).toBe(true);
  });

  it('derives painted-sunset subjects from visual painting evidence', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2023-08-25T13:33:00.000Z]',
        "Caroline: Nah, I haven't. I've been busy painting - here's something I just finished.",
        '  Image caption: a photo of a painting of a sunset on a small easel',
        '  Image query: vibrant sunset beach painting',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact === 'As of August 25, 2023, Caroline painted the subject of sunsets.')).toBe(true);
  });

  it('keeps multiple unique visual facts from the same speaker', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2023-05-01T18:24:00.000Z]',
        'Dave: I opened my own car maintenance shop. Take a look.',
        '  Image caption: a photo of a car dealership with cars parked in front of it',
        '  Image query: car maintenance shop exterior',
        'Dave: This is a photo of my shop. Come by sometime.',
        '  Image caption: a photo of a group of people standing in front of a car',
        '  Image query: car maintenance shop grand opening',
      ].join('\n'),
          { locomoTunedExtractionEnabled: true },
    );

    expect(merged.some((fact) => fact.fact.includes('car maintenance shop exterior'))).toBe(true);
    expect(merged.some((fact) => fact.fact.includes('group of people standing in front of a car'))).toBe(true);
    expect(merged.some((fact) => fact.fact.includes('car maintenance shop grand opening'))).toBe(true);
  });

  // Gate behavior: Track A (quickExtractFacts) always fires. Track B (the
  // narrow LoCoMo-tuned extractors) fires only when locomoTunedExtractionEnabled.
  describe('locomoTunedExtractionEnabled gate', () => {
    it('skips LoCoMo-shaped facts when the flag is false', () => {
      const merged = mergeSupplementalFacts(
        [],
        [
          '[Session date: 2023-05-01T18:24:00.000Z]',
          'Dave: I opened my own car maintenance shop. Take a look.',
          '  Image caption: a photo of a car dealership with cars parked in front of it',
          '  Image query: car maintenance shop exterior',
        ].join('\n'),
        { locomoTunedExtractionEnabled: false },
      );

      expect(merged.some((fact) => fact.fact.includes('car maintenance shop exterior'))).toBe(false);
    });

    it('still runs quickExtractFacts when the flag is false (production-safety regression guard)', () => {
      // Pre-existing main behavior: quickExtractFacts surfaces a Plaid integration
      // fact. The flag must not gate that path — only the Track B extractors.
      const merged = mergeSupplementalFacts(
        [],
        '[Session date: 2026-01-22]\nUser: Quick update on the finance tracker. I added Plaid integration for bank account syncing.',
        { locomoTunedExtractionEnabled: false },
      );

      expect(merged.some((fact) => fact.fact.includes('Plaid integration'))).toBe(true);
    });

    it('runs LoCoMo-shaped facts when the flag is true (parity with PR #1 HEAD behavior)', () => {
      const merged = mergeSupplementalFacts(
        [],
        [
          '[Session date: 2023-05-01T18:24:00.000Z]',
          'Dave: I opened my own car maintenance shop. Take a look.',
          '  Image caption: a photo of a car dealership with cars parked in front of it',
          '  Image query: car maintenance shop exterior',
        ].join('\n'),
        { locomoTunedExtractionEnabled: true },
      );

      expect(merged.some((fact) => fact.fact.includes('car maintenance shop exterior'))).toBe(true);
    });
  });
});
