// Eigene, freie deutsche Übertragungen (keine geschützten modernen Übersetzungen).
// Schwerpunkt: Übung, Mühe, Disziplin, Körper und Gewohnheit.
import { parseYmd } from './stats.js';

const M = 'Marcus Aurelius', S = 'Seneca', E = 'Epiktet', R = 'Musonius Rufus';
const SB = 'Selbstbetrachtungen', BL = 'Briefe an Lucilius', HB = 'Handbüchlein', D = 'Diatriben';

export const QUOTES = [
  [M, `${SB} V, 1`, 'Wenn du morgens ungern aufstehst, sag dir: Ich erwache, um das Werk eines Menschen zu tun.'],
  [E, `${D} II, 18`, 'Jede Fähigkeit wird durch die ihr entsprechende Tätigkeit erhalten und gestärkt: das Gehen durch Gehen, das Laufen durch Laufen.'],
  [S, `${BL} 15, 4`, 'Es gibt kurze und einfache Übungen, die den Körper rasch ermüden und Zeit sparen: Laufen, Heben, Springen. Dann kehre bald zum Geist zurück.'],
  [R, 'Lehrvortrag VI', 'Wer Kälte, Hitze, Hunger und Mühe erträgt, übt nicht nur den Körper, sondern zugleich die Seele in Standhaftigkeit.'],
  [E, `${HB} 29`, 'Du willst in Olympia siegen? Dann bedenke, was vorher kommt: Ordnung, festes Essen, Training zur festgesetzten Stunde, bei Hitze wie bei Kälte.'],
  [M, `${SB} V, 20`, 'Was dem Handeln im Weg steht, fördert das Handeln. Was den Weg versperrt, wird zum Weg.'],
  [S, 'Über die Vorsehung 5', 'Feuer prüft das Gold, Mühsal den tapferen Menschen.'],
  [E, `${D} I, 24`, 'Schwierigkeiten zeigen, wer einer ist. Wenn eine kommt, denk daran: Du wurdest wie ein Ringer einem harten Trainingspartner zugeteilt.'],
  [M, `${SB} X, 16`, 'Nicht länger darüber reden, wie ein guter Mensch sein soll – einer sein.'],
  [R, 'Fragment 51', 'Tust du Gutes unter Mühe, vergeht die Mühe, das Gute bleibt.'],
  [M, `${SB} VII, 61`, 'Die Kunst zu leben gleicht mehr dem Ringen als dem Tanzen: bereit und fest stehen gegen das, was unerwartet kommt.'],
  [E, `${HB} 47`, 'Willst du dich in Härte üben, dann tu es für dich, nicht vor Zuschauern.'],
  [S, `${BL} 80, 2`, 'Wie viele Schläge nehmen Athleten hin für die Kraft des Körpers! Wie viel mehr dürfen wir ertragen für die Kraft des Geistes.'],
  [M, `${SB} V, 9`, 'Wenn es nicht gelingt, verzage nicht und gib nicht auf. Kehre zurück und freue dich, wenn das meiste menschenwürdig war.'],
  [E, `${HB} 51`, 'Wie lange willst du das Beste noch aufschieben? Der Wettkampf ist jetzt, die Spiele sind eröffnet, ein Aufschub ist nicht mehr möglich.'],
  [M, `${SB} VIII, 36`, 'Lass dich nicht vom Gedanken an das ganze Leben erdrücken. Frag bei dem, was jetzt vor dir liegt: Was daran ist unerträglich?'],
  [S, `${BL} 1, 3`, 'Während wir aufschieben, eilt das Leben vorüber.'],
  [M, `${SB} IV, 49`, 'Sei wie die Klippe, an der sich die Wellen unablässig brechen. Sie steht, und um sie herum legt sich das Wasser.'],
  [E, 'überliefert bei Aulus Gellius', 'Ertrage und entsage.'],
  [S, `${BL} 37, 4`, 'Willst du dir alles unterwerfen, so unterwirf dich der Vernunft.'],
  [M, `${SB} VI, 30`, 'Ringe darum, der zu bleiben, zu dem die Philosophie dich machen wollte.'],
  [S, 'Über die Kürze des Lebens 1', 'Nicht wenig Zeit haben wir, sondern viel davon verlieren wir.'],
  [M, `${SB} II, 5`, 'Tu jede Handlung so, als wäre sie die letzte deines Lebens: ohne Hast, ohne Trägheit, ohne Selbsttäuschung.'],
  [E, `${D} III, 12`, 'Übung heißt nicht, Kunststücke zu suchen, sondern sich gegen das zu stärken, was uns leicht überwältigt.'],
  [R, 'Lehrvortrag VII', 'Wir sollten Mühe nicht fliehen, sondern sie suchen – um des Guten willen, das sie hervorbringt.'],
  [S, `${BL} 23, 4`, 'Wahre Freude ist eine ernste Sache.'],
  [M, `${SB} VIII, 47`, 'Bedrückt dich etwas von außen, so ist es nicht die Sache, sondern dein Urteil darüber – und das kannst du ändern.'],
  [E, `${HB} 1`, 'Einiges steht in unserer Macht, anderes nicht. In unserer Macht steht, was unser eigenes Werk ist.'],
].map(([author, source, text]) => ({ author, source, text }));

// Gleiches Datum → gleiches Zitat auf allen Geräten.
export function quoteForDate(ymd) {
  const d = parseYmd(ymd);
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  return QUOTES[((day % QUOTES.length) + QUOTES.length) % QUOTES.length];
}
