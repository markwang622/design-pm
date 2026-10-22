import assert from 'node:assert/strict';
import { privateRequestUrl } from '../src/lib/requestPrivacy.js';
for(const input of ['/api/ical/calendar.ics?token=PRIVATE&scope=mine','/api/ical/calendar.ics?%74oken=PRIVATE','/api/ical/calendar.ics?key=PRIVATE&token=PRIVATE','https://example.test/a?token=PRIVATE']){
  const result=privateRequestUrl(input);assert(!result.includes('PRIVATE'));assert.match(result,/redacted/);
}
assert.equal(privateRequestUrl('/api/cases?includeArchived=1'),'/api/cases?includeArchived=1');
console.log('PASS subscription credentials never appear in logged request URLs');
console.log(JSON.stringify({passed:1}));
