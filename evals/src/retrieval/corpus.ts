// 40 short synthetic documents over 8 everyday topics (sourdough, beekeeping, marathon training,
// houseplants, budgeting, bicycles, stargazing, compost), five each. The topics share words on purpose
// ("feed", "rest", "moisture", "mites", "flat", "winter", "soil"), and a few documents are near-duplicates
// of one another, so ranking has to separate them. Plain original text, no real data.
//
// Written before any search was run over it (see PROVENANCE.md).

export interface CorpusDoc {
  readonly id: string;
  readonly topic: string;
  readonly text: string;
}

export const DOCS: readonly CorpusDoc[] = [
  // ── sourdough ──
  {
    id: "d01",
    topic: "sourdough",
    text: "Feeding a sourdough starter: discard most of the starter, then mix the remainder with equal weights of flour and water. A healthy starter doubles in size within about six hours of feeding and smells pleasantly tangy.",
  },
  {
    id: "d02",
    topic: "sourdough",
    text: "Bulk fermentation is the first long rise of sourdough dough. At room temperature it takes four to six hours; a cooler kitchen needs longer. The dough is ready when it has grown by half and feels airy and jiggly.",
  },
  {
    id: "d03",
    topic: "sourdough",
    text: "Baking sourdough in a Dutch oven traps steam so the crust can expand before it sets. Preheat the pot for a full hour, bake covered for twenty minutes, then uncover to brown the crust.",
  },
  {
    id: "d04",
    topic: "sourdough",
    text: "Dough hydration is the weight of water divided by the weight of flour. A wetter dough, around eighty percent, gives an open crumb with big holes but is sticky and harder to shape.",
  },
  {
    id: "d05",
    topic: "sourdough",
    text: "If the loaf spreads flat in the oven the dough was probably over-proofed. Shape it tighter and shorten the final rest, or chill it in the refrigerator overnight to slow fermentation.",
  },

  // ── beekeeping ──
  {
    id: "d06",
    topic: "beekeeping",
    text: "A healthy honey bee colony has one queen, thousands of workers and a few drones. The queen lays eggs in a tight pattern; a spotty pattern can mean disease or an ageing queen.",
  },
  {
    id: "d07",
    topic: "beekeeping",
    text: "Inspect a hive every one to two weeks in the warm season. Use smoke to calm the bees, work slowly, and look for eggs, capped brood and stores of honey before closing the boxes.",
  },
  {
    id: "d08",
    topic: "beekeeping",
    text: "Swarming happens when a crowded colony raises a new queen and half the bees leave with the old one. Giving the colony more space and splitting the hive early reduces the chance.",
  },
  {
    id: "d09",
    topic: "beekeeping",
    text: "Feed a weak colony sugar syrup in autumn so it can build winter stores. Mix equal parts sugar and water, and stop feeding once the bees stop taking it down.",
  },
  {
    id: "d10",
    topic: "beekeeping",
    text: "Varroa mites feed on bees and spread viruses. Count the mites that fall on a sticky board each week, and treat the hive with an approved miticide if the count passes the threshold.",
  },

  // ── marathon training ──
  {
    id: "d11",
    topic: "marathon",
    text: "A sixteen week marathon plan builds the weekly mileage gradually, adding no more than ten percent each week, with a long run on the weekend that grows to about twenty miles.",
  },
  {
    id: "d12",
    topic: "marathon",
    text: "Tapering means cutting mileage in the final two to three weeks so the legs are fresh on race day. Keep some intensity, but reduce the long run and rest more.",
  },
  {
    id: "d13",
    topic: "marathon",
    text: "Rest days let muscles repair and adapt. Skipping rest to train through soreness raises the risk of stress fractures and tendon injuries, so schedule at least one full rest day per week.",
  },
  {
    id: "d14",
    topic: "marathon",
    text: "During a long run, take in thirty to sixty grams of carbohydrate per hour from gels or drinks, and sip water regularly. Practice the race day fueling in training to avoid stomach trouble.",
  },
  {
    id: "d15",
    topic: "marathon",
    text: "Shin splints cause pain along the front of the lower leg. Cut back on mileage, ice the area, run on softer surfaces and replace worn shoes, which lose their cushioning after about five hundred miles.",
  },

  // ── houseplants ──
  {
    id: "d16",
    topic: "houseplants",
    text: "Most houseplants die from overwatering. Push a finger two inches into the soil and water only when it feels dry, then let the excess drain from the pot so the roots never sit in water.",
  },
  {
    id: "d17",
    topic: "houseplants",
    text: "Yellow lower leaves on a houseplant usually point to too much water, while brown crispy tips suggest dry air or underwatering. Check the soil moisture before changing anything else.",
  },
  {
    id: "d18",
    topic: "houseplants",
    text: "Repot a houseplant when roots circle the inside of the pot or poke out of the drainage holes. Choose a container one size larger and use fresh potting mix with good drainage.",
  },
  {
    id: "d19",
    topic: "houseplants",
    text: "Feed houseplants with a diluted liquid fertilizer every month during spring and summer, and stop in winter when growth slows. Too much fertilizer burns the roots.",
  },
  {
    id: "d20",
    topic: "houseplants",
    text: "Spider mites leave fine webs and speckled leaves. Rinse the plant in the shower, wipe the leaves, and treat with insecticidal soap every few days until the pests are gone.",
  },

  // ── budgeting ──
  {
    id: "d21",
    topic: "budgeting",
    text: "The fifty thirty twenty rule splits take-home pay into needs, wants and savings. Half covers rent and bills, thirty percent goes to fun, and twenty percent is saved or used to pay down debt.",
  },
  {
    id: "d22",
    topic: "budgeting",
    text: "An emergency fund holds three to six months of essential expenses in an easily accessible savings account. Build it before investing so a job loss does not force you to borrow.",
  },
  {
    id: "d23",
    topic: "budgeting",
    text: "Pay off the debt with the highest interest rate first, the avalanche method, to minimize the total interest. The snowball method clears the smallest balance first for motivation instead.",
  },
  {
    id: "d24",
    topic: "budgeting",
    text: "Track spending for a month by categorizing every transaction. Most people find small recurring subscriptions and food delivery add up to more than they expected.",
  },
  {
    id: "d25",
    topic: "budgeting",
    text: "Compound interest means earning interest on past interest. Investing a small amount every month early in life grows far larger by retirement than a bigger amount started late.",
  },

  // ── bicycles ──
  {
    id: "d26",
    topic: "bicycles",
    text: "Check tire pressure before every ride. Road tires want eighty to one hundred ten psi, while wide mountain bike tires run at thirty to fifty. Low pressure causes pinch flats and sluggish rolling.",
  },
  {
    id: "d27",
    topic: "bicycles",
    text: "Lubricate the bicycle chain every few hundred miles. Wipe off dirt, apply a drop of lube to each link, spin the pedals, and wipe away the excess so it does not attract grit.",
  },
  {
    id: "d28",
    topic: "bicycles",
    text: "To fix a flat tire, remove the wheel, pry off one side of the tire, pull out the punctured tube, check the inside for thorns, and fit a new tube before inflating.",
  },
  {
    id: "d29",
    topic: "bicycles",
    text: "Brake pads wear down with use. Replace them when the grooves disappear, and make sure the pad hits the rim squarely without touching the tire.",
  },
  {
    id: "d30",
    topic: "bicycles",
    text: "A slipping gear shift usually needs a cable tension adjustment. Turn the barrel adjuster a quarter turn at a time while pedaling in the stand until the chain moves cleanly between cogs.",
  },

  // ── stargazing ──
  {
    id: "d31",
    topic: "stargazing",
    text: "Give your eyes twenty minutes to adapt to the dark before stargazing, and avoid white light. A red flashlight keeps your night vision intact while you read a star chart.",
  },
  {
    id: "d32",
    topic: "stargazing",
    text: "The best nights for viewing are moonless and clear. Check a light pollution map and drive away from city lights to see the Milky Way with the naked eye.",
  },
  {
    id: "d33",
    topic: "stargazing",
    text: "Start with binoculars before buying a telescope. A pair of seven by fifty binoculars shows lunar craters, the moons of Jupiter and many star clusters at a modest price.",
  },
  {
    id: "d34",
    topic: "stargazing",
    text: "Jupiter and Saturn are easy planets to find because they shine steadily without twinkling. In a small telescope Jupiter shows cloud bands and four bright moons, and Saturn shows its rings.",
  },
  {
    id: "d35",
    topic: "stargazing",
    text: "Meteor showers such as the Perseids peak in August. Lie back on a blanket, look at the darkest part of the sky, and be patient; a clear night can show dozens of meteors per hour.",
  },

  // ── compost ──
  {
    id: "d36",
    topic: "compost",
    text: "A compost pile needs a balance of green material rich in nitrogen, like kitchen scraps, and brown material rich in carbon, like dry leaves. Aim for roughly two parts brown to one part green.",
  },
  {
    id: "d37",
    topic: "compost",
    text: "Keep the compost as damp as a wrung-out sponge. A pile that is too wet smells bad and turns slimy, while a dry pile decomposes slowly; add water or dry leaves to correct it.",
  },
  {
    id: "d38",
    topic: "compost",
    text: "Turn the compost pile every week or two to add oxygen. A hot pile that reaches one hundred forty degrees breaks down quickly and kills most weed seeds.",
  },
  {
    id: "d39",
    topic: "compost",
    text: "Do not compost meat, dairy or oily food, which attract rats and flies. Eggshells, coffee grounds, vegetable scraps and garden trimmings are good ingredients.",
  },
  {
    id: "d40",
    topic: "compost",
    text: "Finished compost is dark, crumbly and smells like earth. Spread it on garden beds or mix it into potting soil to feed plants and help the soil hold moisture.",
  },
];
