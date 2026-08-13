-- AlterTable
ALTER TABLE "rental_applications" ADD COLUMN     "applicantFirstName" TEXT,
ADD COLUMN     "applicantLastName" TEXT,
ADD COLUMN     "currentAddressStartDateAt" TIMESTAMP(3);
