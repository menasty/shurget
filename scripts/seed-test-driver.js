/**
 * Seed test driver into driver_applications.
 * Runs manually against a dev Neon instance (or any DATABASE_URL target).
 *
 * Usage:
 *   DATABASE_URL=REDACTED
      phone: '+1-555-0142',
      vehicleType: 'pickup_truck',
      city: 'Austin',
      vehicleInsuranceDoc: null,
      driverLicenseDoc: null,
      vehicleRegistrationDoc: null,
    });
    console.log('Seeded driver:', row);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
