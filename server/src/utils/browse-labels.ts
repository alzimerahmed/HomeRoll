/**
 * Curated taxonomy for the browsable CLIP-label discovery surface (FG-16).
 *
 * Each entry maps a stable `key` (API surface) to a human-readable `label`
 * and a CLIP text `prompt` that gets encoded into an embedding and matched
 * against `smart_search` embeddings. Prompts follow the "a photo of ..."
 * zero-shot convention CLIP models are trained for.
 *
 * Keys are API-contract: never rename without a version bump; add/remove only.
 */
export interface BrowseLabel {
  key: string;
  label: string;
  prompt: string;
}

export const BROWSE_LABELS: BrowseLabel[] = [
  // nature & outdoors
  { key: 'beach', label: 'Beach', prompt: 'a photo of a beach' },
  { key: 'mountains', label: 'Mountains', prompt: 'a photo of mountains' },
  { key: 'forest', label: 'Forest', prompt: 'a photo of a forest' },
  { key: 'lake', label: 'Lake', prompt: 'a photo of a lake' },
  { key: 'waterfall', label: 'Waterfall', prompt: 'a photo of a waterfall' },
  { key: 'river', label: 'River', prompt: 'a photo of a river' },
  { key: 'desert', label: 'Desert', prompt: 'a photo of a desert' },
  { key: 'sunset', label: 'Sunset', prompt: 'a photo of a sunset' },
  { key: 'snow', label: 'Snow', prompt: 'a photo of a snowy scene' },
  { key: 'flowers', label: 'Flowers', prompt: 'a photo of flowers' },
  { key: 'garden', label: 'Garden', prompt: 'a photo of a garden' },
  { key: 'night', label: 'Night', prompt: 'a photo taken at night' },
  { key: 'underwater', label: 'Underwater', prompt: 'an underwater photo' },
  { key: 'fireworks', label: 'Fireworks', prompt: 'a photo of fireworks' },

  // animals
  { key: 'dogs', label: 'Dogs', prompt: 'a photo of a dog' },
  { key: 'cats', label: 'Cats', prompt: 'a photo of a cat' },
  { key: 'birds', label: 'Birds', prompt: 'a photo of a bird' },
  { key: 'wildlife', label: 'Wildlife', prompt: 'a photo of a wild animal' },
  { key: 'pets', label: 'Pets', prompt: 'a photo of a pet' },
  { key: 'insects', label: 'Insects', prompt: 'a close-up photo of an insect' },

  // food & drink
  { key: 'food', label: 'Food', prompt: 'a photo of a meal on a plate' },
  { key: 'drinks', label: 'Drinks', prompt: 'a photo of a drink' },
  { key: 'desserts', label: 'Desserts', prompt: 'a photo of a dessert or cake' },
  { key: 'coffee', label: 'Coffee', prompt: 'a photo of a cup of coffee' },

  // city & architecture
  { key: 'city', label: 'City', prompt: 'a photo of a city skyline' },
  { key: 'architecture', label: 'Architecture', prompt: 'a photo of an interesting building' },
  { key: 'street', label: 'Street', prompt: 'a photo of a street scene' },
  { key: 'bridge', label: 'Bridge', prompt: 'a photo of a bridge' },
  { key: 'landmark', label: 'Landmark', prompt: 'a photo of a famous landmark or monument' },
  { key: 'interior', label: 'Interior', prompt: 'a photo of a room interior' },

  // people & events
  { key: 'portraits', label: 'Portraits', prompt: 'a portrait photo of a person' },
  { key: 'selfies', label: 'Selfies', prompt: 'a selfie photo' },
  { key: 'groups', label: 'Groups', prompt: 'a group photo of people' },
  { key: 'children', label: 'Children', prompt: 'a photo of children' },
  { key: 'babies', label: 'Babies', prompt: 'a photo of a baby' },
  { key: 'weddings', label: 'Weddings', prompt: 'a photo of a wedding' },
  { key: 'birthdays', label: 'Birthdays', prompt: 'a photo of a birthday party' },
  { key: 'parties', label: 'Parties', prompt: 'a photo of a party or celebration' },
  { key: 'concerts', label: 'Concerts', prompt: 'a photo of a concert' },
  { key: 'graduation', label: 'Graduation', prompt: 'a photo of a graduation ceremony' },

  // sports & activities
  { key: 'sports', label: 'Sports', prompt: 'a photo of people playing a sport' },
  { key: 'hiking', label: 'Hiking', prompt: 'a photo of people hiking on a trail' },
  { key: 'swimming', label: 'Swimming', prompt: 'a photo of people swimming' },
  { key: 'skiing', label: 'Skiing', prompt: 'a photo of people skiing' },
  { key: 'cycling', label: 'Cycling', prompt: 'a photo of people cycling' },
  { key: 'camping', label: 'Camping', prompt: 'a photo of a campsite or tent' },

  // vehicles & travel
  { key: 'cars', label: 'Cars', prompt: 'a photo of a car' },
  { key: 'motorcycles', label: 'Motorcycles', prompt: 'a photo of a motorcycle' },
  { key: 'bicycles', label: 'Bicycles', prompt: 'a photo of a bicycle' },
  { key: 'airplanes', label: 'Airplanes', prompt: 'a photo of an airplane' },
  { key: 'boats', label: 'Boats', prompt: 'a photo of a boat' },
  { key: 'trains', label: 'Trains', prompt: 'a photo of a train' },

  // documents & screens
  { key: 'screenshots', label: 'Screenshots', prompt: 'a screenshot' },
  { key: 'documents', label: 'Documents', prompt: 'a photo of a document or paper' },
  { key: 'whiteboards', label: 'Whiteboards', prompt: 'a photo of a whiteboard or presentation slide' },
  { key: 'signs', label: 'Signs', prompt: 'a photo of a sign with text' },
  { key: 'maps', label: 'Maps', prompt: 'a photo of a map' },
  { key: 'art', label: 'Art', prompt: 'a photo of a painting or artwork' },
  { key: 'memes', label: 'Memes', prompt: 'a meme image' },
];

const labelIndex = new Map(BROWSE_LABELS.map((label) => [label.key, label]));

export const getBrowseLabel = (key: string): BrowseLabel | undefined => labelIndex.get(key);
