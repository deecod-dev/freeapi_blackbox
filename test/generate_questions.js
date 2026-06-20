const fs = require('fs');
const path = require('path');

const questions = [];

// 1. Math Questions (50 questions)
for (let i = 1; i <= 50; i++) {
  const a = i * 2 + 3;
  const b = i * 3 - 1;
  questions.push(`What is ${a} + ${b}?`);
}

// 2. Geography (50 questions)
const countries = [
  "France", "Germany", "Italy", "Spain", "Japan", "China", "India", "Canada", "Australia", "Brazil",
  "Mexico", "Egypt", "Russia", "South Africa", "United Kingdom", "Argentina", "Sweden", "Norway", "Denmark", "Finland",
  "Portugal", "Greece", "Turkey", "Kenya", "Nigeria", "Saudi Arabia", "Thailand", "Vietnam", "South Korea", "Indonesia",
  "New Zealand", "Switzerland", "Austria", "Belgium", "Netherlands", "Poland", "Hungary", "Ireland", "Colombia", "Peru",
  "Chile", "Ukraine", "Egypt", "Morocco", "Singapore", "Malaysia", "Philippines", "Pakistan", "Bangladesh", "Iran"
];
countries.forEach((country, idx) => {
  questions.push(`What is the capital of ${country}?`);
});

// 3. Science and Elements (50 questions)
const elements = [
  { name: "Hydrogen", sym: "H" }, { name: "Helium", sym: "He" }, { name: "Lithium", sym: "Li" },
  { name: "Beryllium", sym: "Be" }, { name: "Boron", sym: "B" }, { name: "Carbon", sym: "C" },
  { name: "Nitrogen", sym: "N" }, { name: "Oxygen", sym: "O" }, { name: "Fluorine", sym: "F" },
  { name: "Neon", sym: "Ne" }, { name: "Sodium", sym: "Na" }, { name: "Magnesium", sym: "Mg" },
  { name: "Aluminum", sym: "Al" }, { name: "Silicon", sym: "Si" }, { name: "Phosphorus", sym: "P" },
  { name: "Sulfur", sym: "S" }, { name: "Chlorine", sym: "Cl" }, { name: "Argon", sym: "Ar" },
  { name: "Potassium", sym: "K" }, { name: "Calcium", sym: "Ca" }, { name: "Iron", sym: "Fe" },
  { name: "Copper", sym: "Cu" }, { name: "Zinc", sym: "Zn" }, { name: "Silver", sym: "Ag" },
  { name: "Gold", sym: "Au" }, { name: "Mercury", sym: "Hg" }, { name: "Lead", sym: "Pb" },
  { name: "Tin", sym: "Sn" }, { name: "Nickel", sym: "Ni" }, { name: "Platinum", sym: "Pt" }
];
for (let i = 0; i < 50; i++) {
  const el = elements[i % elements.length];
  if (i % 2 === 0) {
    questions.push(`What is the chemical symbol for the element ${el.name}?`);
  } else {
    questions.push(`Which chemical element is represented by the symbol '${el.sym}'?`);
  }
}

// 4. Opposites and Antonyms (50 questions)
const antonyms = [
  ["hot", "cold"], ["big", "small"], ["tall", "short"], ["heavy", "light"], ["fast", "slow"],
  ["wet", "dry"], ["dark", "light"], ["hard", "soft"], ["sharp", "dull"], ["sweet", "sour"],
  ["loud", "quiet"], ["rough", "smooth"], ["happy", "sad"], ["rich", "poor"], ["clean", "dirty"],
  ["thick", "thin"], ["wide", "narrow"], ["deep", "shallow"], ["brave", "cowardly"], ["clever", "foolish"],
  ["strong", "weak"], ["young", "old"], ["new", "old"], ["good", "bad"], ["right", "wrong"],
  ["true", "false"], ["easy", "difficult"], ["simple", "complex"], ["cheap", "expensive"], ["beautiful", "ugly"]
];
for (let i = 0; i < 50; i++) {
  const pair = antonyms[i % antonyms.length];
  questions.push(`What is the opposite of the word '${pair[0]}'?`);
}

// 5. Trivia and General Knowledge (50 questions)
const generalTrivia = [
  "How many legs does a spider have?",
  "How many hours are there in a day?",
  "How many days are in a leap year?",
  "What is the largest ocean on Earth?",
  "Who painted the Mona Lisa?",
  "What color is a ripe banana?",
  "What is the primary gas in the Earth's atmosphere?",
  "What is the closest star to Earth?",
  "What is the freezing point of water in Celsius?",
  "What is the boiling point of water in Celsius?",
  "How many letters are there in the English alphabet?",
  "What is the name of the planet we live on?",
  "Which planet is known as the Red Planet?",
  "What is the largest planet in our solar system?",
  "What do bees make?",
  "How many cents are in a dollar?",
  "How many minutes are in one hour?",
  "What is the square root of 64?",
  "Which bird is known for its ability to mimic human speech?",
  "What is the tallest animal on Earth?",
  "What is the largest mammal on Earth?",
  "Which country is home to the kangaroo?",
  "What is the currency of the United States?",
  "What language is spoken in Brazil?",
  "What is the name of the fairy tale character who loses her glass slipper?",
  "What shape is a stop sign?",
  "How many colors are in a rainbow?",
  "What is the name of the toy cowboy in Toy Story?",
  "Which season comes after winter?",
  "What color is grass?",
  "What do we use to see?",
  "What do we use to hear?",
  "How many primary colors are there?",
  "What is the color of milk?",
  "How many cards are in a standard playing deck?",
  "What is the name of the dry area with very little rain?",
  "What do you call a baby dog?",
  "What do you call a baby cat?",
  "Which instrument has keys, pedals, and strings?",
  "How many wheels does a tricycle have?",
  "What is the color of coal?",
  "Which country is shaped like a boot?",
  "What is the main ingredient in bread?",
  "How many bones are in an adult human body?",
  "What is the name of the gas that humans breathe out?",
  "Who was the first president of the United States?",
  "Which ocean is between the Americas and Europe?",
  "What is the name of the long sleep animals take in winter?",
  "What color is a ruby?",
  "What is the name of the ship that sank in 1912?"
];
generalTrivia.forEach(q => {
  questions.push(q);
});

// 6. Word play, Spelling and Definitions (50 questions)
const words = [
  "apple", "banana", "cat", "dog", "elephant", "flower", "giraffe", "house", "island", "jungle",
  "koala", "lemon", "monkey", "nurse", "orange", "penguin", "queen", "rabbit", "snake", "tiger",
  "umbrella", "violin", "whale", "xylophone", "yellow", "zebra"
];
for (let i = 0; i < 50; i++) {
  const w = words[i % words.length];
  if (i % 2 === 0) {
    questions.push(`Spell the word '${w}'.`);
  } else {
    questions.push(`Define the word '${w}' in five words or less.`);
  }
}

// Check if we got exactly 300 questions
console.log(`Generated ${questions.length} questions.`);

// Ensure it is exactly 300 (or trim/pad if necessary)
while (questions.length < 300) {
  questions.push(`What is ${questions.length} + 1?`);
}
if (questions.length > 300) {
  questions.length = 300;
}

const dir = path.join(__dirname);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(
  path.join(dir, 'questions.json'),
  JSON.stringify(questions, null, 2)
);
console.log('Saved questions to test/questions.json');
