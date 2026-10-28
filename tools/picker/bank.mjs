const { fetchTTCard, normalise, storeTT } = await import(process.cwd() + "/api/_tt.js");
const { events } = await fetchTTCard();
console.log("stored", JSON.stringify(await storeTT(events.map(normalise))).slice(0, 200));
