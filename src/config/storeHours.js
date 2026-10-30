// One continuous daily service window, interpreted in the shop's time zone.
const STORE_HOURS = Object.freeze({ opensAt: '10:00', closesAt: '23:00', timeZone: 'Asia/Kolkata' });
function storeStatus(now = Date.now(), config = {}) {
  if (config && (config.isStoreOpen === false || config.storeOpen === false)) {
    return { isOpen: false, label: 'Store is closed for orders', ...STORE_HOURS };
  }
  // An explicit admin "open" setting is a manual override, including outside
  // the normal daily schedule. Missing flags continue to use scheduled hours.
  if (config && (config.isStoreOpen === true || config.storeOpen === true)) {
    return { isOpen: true, label: 'Store is open for orders', ...STORE_HOURS };
  }
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return { isOpen: false, label: 'Open daily 10 AM–11 PM' };
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: STORE_HOURS.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const hour = Number(parts.find(part => part.type === 'hour').value);
  const minute = Number(parts.find(part => part.type === 'minute').value);
  const minutes = hour * 60 + minute;
  const isOpen = minutes >= 600 && minutes < 1380;
  return { isOpen, label: isOpen ? 'Open until 11 PM · No slots' : 'Closed · Opens at 10 AM', ...STORE_HOURS };
}
function withStoreHours(config = {}) {
  return { ...config, storeHours: { ...STORE_HOURS }, deliveryMode: 'ON_DEMAND', slots: [] };
}
module.exports = { STORE_HOURS, storeStatus, withStoreHours };
