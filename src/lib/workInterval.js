// Natural date intervals: dispatchDate is inclusive; the reporting end is exclusive.
// An ongoing case has no end. Terminal cases missing an end remain visible and flagged.
export function workIntervalWhere(win, staffId) {
  return {
    dispatchDate: { lt: win.end },
    AND: [
      { OR: [
        { status: { notIn: ['done','closed','cancelled'] } },
        { status: { in: ['done','closed'] }, OR: [{ closedOn: { gte: win.start } }, { closedOn: null }] },
        { status: 'cancelled', OR: [{ cancelledOn: { gte: win.start } }, { cancelledOn: null }] },
      ] },
      ...(staffId ? [{ OR: [{ designerId: Number(staffId) }, { collaborators: { some: { id: Number(staffId) } } }] }] : []),
    ],
  };
}
