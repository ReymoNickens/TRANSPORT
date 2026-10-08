/** Row shapes returned by the Phase B services (camelCase, money in pesewas). */

export type Location = {
  id: string;
  name: string;
  locationType: "terminal" | "station" | "stop";
  city: string;
  region: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  contactPhone: string | null;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
};

export type RouteStatus = "draft" | "active" | "archived";

export type RouteSummary = {
  id: string;
  name: string;
  status: RouteStatus;
  distanceKm: number | null;
  originName: string;
  destinationName: string;
  durationMinutes: number | null;
  stopCount: number;
};

export type RouteStop = {
  id: string;
  sequence: number;
  locationId: string;
  locationName: string;
  city: string;
  arrivalOffsetMinutes: number;
  departureOffsetMinutes: number;
  boardingAllowed: boolean;
  dropoffAllowed: boolean;
};

export type Route = {
  id: string;
  name: string;
  status: RouteStatus;
  distanceKm: number | null;
  originLocationId: string;
  destinationLocationId: string;
  activatedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Derived from the last stop's arrival offset; never stored. */
  durationMinutes: number | null;
  stops: RouteStop[];
};

export type VehicleStatus = "active" | "maintenance" | "retired";

export type VehicleSummary = {
  id: string;
  registration: string;
  fleetNumber: string | null;
  name: string | null;
  vehicleType: "coach" | "bus" | "minibus";
  make: string | null;
  model: string | null;
  year: number | null;
  capacity: number;
  status: VehicleStatus;
  layoutVersion: number | null;
  layoutName: string | null;
  bookableSeats: number | null;
};

export type LayoutStatus = "draft" | "published" | "retired";

export type LayoutSummary = {
  id: string;
  version: number;
  name: string;
  status: LayoutStatus;
  rowCount: number;
  columnCount: number;
  publishedAt: Date | null;
  retiredAt: Date | null;
  bookableSeats: number;
};

export type Vehicle = Omit<VehicleSummary, "layoutVersion" | "layoutName" | "bookableSeats"> & {
  notes: string | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  layouts: LayoutSummary[];
};

export type Seat = {
  id: string;
  seatNumber: string;
  rowNumber: number;
  columnNumber: number;
  seatType: "standard" | "premium" | "accessible";
  position: "window" | "aisle" | "middle" | null;
  bookable: boolean;
};

export type Layout = Omit<LayoutSummary, "bookableSeats"> & {
  vehicleId: string;
  registration: string;
  capacity: number;
  createdAt: Date;
  seats: Seat[];
};

export type FareTableStatus = "draft" | "active" | "archived";

export type FareRule = {
  id: string;
  originStopId: string;
  originSequence: number;
  originName: string;
  destinationStopId: string;
  destinationSequence: number;
  destinationName: string;
  seatType: Seat["seatType"];
  amountPesewas: number;
  currency: string;
};

export type FareTable = {
  id: string;
  name: string;
  status: FareTableStatus;
  currency: string;
  routeId: string;
  routeName: string;
  activatedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  rules: FareRule[];
};

export type FareTableSummary = Omit<FareTable, "rules" | "createdAt"> & { ruleCount: number };

export type ConcessionType = {
  id: string;
  name: string;
  code: string;
  discountKind: "percent" | "fixed";
  discountBasisPoints: number | null;
  discountPesewas: number | null;
  requiresReference: boolean;
  checkAtBoarding: boolean;
  status: "active" | "archived";
  createdAt: Date;
  updatedAt: Date;
};

export type FeeRuleRow = {
  id: string;
  name: string;
  category: "booking_fee" | "tax";
  calculation: "fixed" | "percent";
  amountPesewas: number | null;
  basisPoints: number | null;
  appliesTo: "all" | "online" | "station";
  status: "active" | "archived";
  createdAt: Date;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// Phase C: scheduling
// ---------------------------------------------------------------------------

export type ScheduleStatus = "active" | "paused" | "archived";

export type ScheduleVersion = {
  version: number;
  departureTime: string;
  daysOfWeek: number[];
  defaultVehicleId: string | null;
  defaultVehicleRegistration: string | null;
  createdAt: Date;
};

export type ScheduleException = {
  id: string;
  serviceDate: string;
  kind: "skip" | "move" | "extra";
  departureTime: string | null;
  reason: string;
};

export type ScheduleSummary = {
  id: string;
  name: string;
  status: ScheduleStatus;
  routeId: string;
  routeName: string;
  currentVersion: number;
  departureTime: string;
  daysOfWeek: number[];
  defaultVehicleRegistration: string | null;
};

export type Schedule = ScheduleSummary & {
  bookingOpenDaysBefore: number | null;
  createdAt: Date;
  versions: ScheduleVersion[];
  exceptions: ScheduleException[];
  upcomingJourneys: number;
};

export type JourneyState = "DRAFT" | "SCHEDULED" | "SALES_CLOSED" | "BOARDING" | "DEPARTED" | "COMPLETED" | "CANCELLED";

export type JourneySummary = {
  id: string;
  routeId: string;
  routeName: string;
  scheduleId: string | null;
  serviceDate: string;
  scheduledDepartureAt: Date;
  scheduledArrivalAt: Date;
  state: JourneyState;
  vehicleRegistration: string | null;
  bookableSeats: number;
  /** Derived: a draft without a bus (D23 "needs a bus"). */
  needsBus: boolean;
  /** Derived: a draft whose route has no live fare table. */
  needsFares: boolean;
};

export type JourneyEvent = {
  eventType: string;
  fromState: string | null;
  toState: string | null;
  delayMinutes: number | null;
  notes: string | null;
  recordedByName: string | null;
  occurredAt: Date;
};

export type JourneyStaffMember = {
  id: string;
  userId: string;
  fullName: string | null;
  staffRole: "driver" | "conductor";
  assignedAt: Date;
};

export type JourneySeat = {
  id: string;
  seatNumber: string;
  seatType: "standard" | "premium" | "accessible";
  rowNumber: number;
  columnNumber: number;
  position: "window" | "aisle" | "middle" | null;
  state: "BOOKABLE" | "BLOCKED";
};

export type Journey = JourneySummary & {
  scheduleVersion: number | null;
  actualDepartureAt: Date | null;
  actualArrivalAt: Date | null;
  delayMinutes: number;
  bookingOpensAt: Date;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  vehicleId: string | null;
  fareCount: number;
  seats: JourneySeat[];
  staff: JourneyStaffMember[];
  events: JourneyEvent[];
};
